import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/app.ts";
import { openDb, rows, type DbHandle } from "../src/db.ts";
import { buildTra } from "../src/arca/wsaa.ts";
import { startFakeArca } from "./fake-arca.ts";

let handle: DbHandle;
let fake: Awaited<ReturnType<typeof startFakeArca>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;

/** CUIT válido distinto en cada test: el ARCA falso numera por CUIT, así cada test arranca de cero. */
function randomCuit(): string {
  for (;;) {
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const sum = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((acc, w, i) => acc + w * Number(base[i]), 0);
    const mod = 11 - (sum % 11);
    if (mod === 10) continue;
    return base + (mod === 11 ? 0 : mod);
  }
}
let CUIT = "20123456786";
const urls = () => ({
  homologacion: { wsaa: `${fake.url}/ws/services/LoginCms`, wsfe: `${fake.url}/wsfev1/service.asmx` },
  produccion: { wsaa: `${fake.url}/ws/services/LoginCms`, wsfe: `${fake.url}/wsfev1/service.asmx` },
});

beforeAll(async () => {
  handle = await openDb({ url: process.env.TEST_DATABASE_URL });
  fake = await startFakeArca();
});
afterAll(async () => {
  await fake.close();
  await handle.close();
});
beforeEach(async () => {
  CUIT = randomCuit();
  await handle.db.execute(sql`TRUNCATE arca_invoices, arca_config, mp_charges, mp_accounts, entities, devices, accounts, tenants CASCADE`);
  app = await buildApp({ db: handle.db, rateLimit: false, appSecret: "secreto-de-prueba", arcaUrls: urls() });
  const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { businessName: "Kiosco", email: `k${Date.now()}@x.com`, password: "clave-segura", deviceName: "PC" } });
  token = res.json().device.token;
});
afterEach(async () => {
  await app.close();
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, t = token) =>
  app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${t}` } });

/** Configura el comercio, genera el CSR, "lo sube a ARCA" (la CA falsa lo firma) y carga el certificado. */
async function setup(condicion: "monotributo" | "responsable_inscripto" = "monotributo", cuit: string = CUIT) {
  const cfg = await call("PUT", "/api/arca/config", { cuit, razonSocial: "Kiosco Don Pepe", condicion, ptoVta: 3, ambiente: "homologacion", domicilio: "Av. Siempreviva 742" });
  expect(cfg.statusCode).toBe(200);
  const csr = await call("POST", "/api/arca/csr");
  expect(csr.json().csrPem).toMatch(/BEGIN CERTIFICATE REQUEST/);
  const certPem = fake.signCsr(csr.json().csrPem);
  const up = await call("PUT", "/api/arca/certificate", { pem: certPem });
  expect(up.statusCode).toBe(200);
  return certPem;
}

const consumidorFinal = { docTipo: 99, docNro: "0", condicion: 5 };
type Receiver = { docTipo: number; docNro: string; condicion: number; name?: string };
const invoice = (lines: { gross: number; ivaRate?: number }[], receiver: Receiver = consumidorFinal, extra: Record<string, unknown> = {}) =>
  call("POST", "/api/arca/invoices", { id: randomUUID(), saleId: randomUUID(), lines, receiver, ...extra });

describe("configuración y certificado", () => {
  it("valida el CUIT y guarda la clave cifrada (nunca se devuelve)", async () => {
    expect((await call("PUT", "/api/arca/config", { cuit: "20-12345678-9", razonSocial: "X", condicion: "monotributo", ptoVta: 1, ambiente: "homologacion" })).statusCode).toBe(400);
    await setup();
    const config = (await call("GET", "/api/arca/config")).json();
    expect(config).toMatchObject({ configured: true, cuit: CUIT, hasCert: true, ready: true, certCuit: CUIT });
    expect(JSON.stringify(config)).not.toMatch(/PRIVATE KEY/);
    const [row] = rows<{ key_enc: string }>(await handle.db.execute(sql`SELECT key_enc FROM arca_config`));
    expect(row!.key_enc).not.toMatch(/PRIVATE KEY/);
  });

  it("rechaza un certificado que no corresponde al pedido", async () => {
    await setup();
    const otherCsr = (await call("POST", "/api/arca/csr")).json().csrPem; // nueva clave
    const res = await call("PUT", "/api/arca/certificate", { pem: fake.signCsr(otherCsr) });
    expect(res.statusCode).toBe(200);
    await call("POST", "/api/arca/csr"); // la clave cambia otra vez: el anterior ya no sirve
    const stale = await call("PUT", "/api/arca/certificate", { pem: fake.signCsr(otherCsr) });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().message).toMatch(/no corresponde/);
  });

  it("la prueba de conexión obtiene el ticket de acceso y lo reutiliza", async () => {
    await setup();
    const first = await call("POST", "/api/arca/test");
    expect(first.json()).toMatchObject({ ok: true, last: { 11: 0 } });
    // ARCA rechaza un segundo login con el TA vigente: si funciona, es porque se reutilizó.
    const second = await call("POST", "/api/arca/test");
    expect(second.statusCode).toBe(200);
  });

  it("en la versión de prueba no se puede pasar a producción", async () => {
    const demo = await buildApp({ db: handle.db, rateLimit: false, appSecret: "x", arcaUrls: urls(), demo: true });
    const res = await demo.inject({
      method: "PUT", url: "/api/arca/config", headers: { authorization: `Bearer ${token}` },
      payload: { cuit: CUIT, razonSocial: "X", condicion: "monotributo", ptoVta: 1, ambiente: "produccion" },
    });
    expect(res.statusCode).toBe(403);
    await demo.close();
  });

  it("el pedido de acceso (TRA) tiene el formato de WSAA", () => {
    const tra = buildTra("wsfe", new Date("2026-10-28T15:00:00Z"));
    expect(tra).toContain("<service>wsfe</service>");
    expect(tra).toContain("<generationTime>2026-10-28T14:50:00Z</generationTime>");
    expect(tra).toContain("<expirationTime>2026-10-28T15:10:00Z</expirationTime>");
  });
});

describe("factura C (monotributo)", () => {
  it("emite con número correlativo, CAE y QR, sin discriminar IVA", async () => {
    await setup("monotributo");
    const res = await invoice([{ gross: 150000 }, { gross: 80000 }]);
    expect(res.statusCode).toBe(200);
    const inv = res.json();
    expect(inv).toMatchObject({ status: "autorizada", cbteTipo: 11, ptoVta: 3, numero: 1, total: 230000, amounts: { neto: 230000, iva: 0, groups: [] } });
    expect(inv.cae).toMatch(/^\d{14}$/);
    expect(inv.qrUrl).toMatch(/^https:\/\/www\.arca\.gob\.ar\/fe\/qr\/\?p=/);
    expect(inv.issuer).toMatchObject({ cuit: CUIT, razonSocial: "Kiosco Don Pepe" });
    const second = (await invoice([{ gross: 1000 }])).json();
    expect(second.numero).toBe(2);
  });

  it("es idempotente: reintentar con el mismo id o la misma venta no emite dos veces", async () => {
    await setup();
    const id = randomUUID();
    const saleId = randomUUID();
    const body = { id, saleId, lines: [{ gross: 5000 }], receiver: consumidorFinal };
    const before = fake.requests.filter((r) => r.op === "FECAESolicitar").length;
    const a = (await call("POST", "/api/arca/invoices", body)).json();
    const b = (await call("POST", "/api/arca/invoices", body)).json();
    const c = (await call("POST", "/api/arca/invoices", { ...body, id: randomUUID() })).json();
    expect(a.numero).toBe(1);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(fake.requests.filter((r) => r.op === "FECAESolicitar").length - before).toBe(1);
  });

  it("si se pierde la respuesta de ARCA, el reintento recupera el comprobante sin duplicarlo", async () => {
    await setup();
    const body = { id: randomUUID(), saleId: randomUUID(), lines: [{ gross: 9900 }], receiver: consumidorFinal };
    fake.dropNextResponse();
    const lost = await call("POST", "/api/arca/invoices", body);
    expect(lost.statusCode).toBe(502);
    const retry = (await call("POST", "/api/arca/invoices", body)).json();
    expect(retry).toMatchObject({ status: "autorizada", numero: 1 });
    expect([...fake.comps.keys()].filter((k) => k.startsWith(`${CUIT}:`))).toHaveLength(1);
  });

  it("si otro sistema usó el número, pide el siguiente", async () => {
    await setup();
    await (await fetch(`${fake.url}/__fake/bump`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cuit: CUIT, ptoVta: 3, tipo: 11, numero: 7 }) })).json();
    expect((await invoice([{ gross: 1000 }])).json()).toMatchObject({ status: "autorizada", numero: 8 });
  });

  it("nota de crédito asociada a la factura", async () => {
    await setup();
    const inv = (await invoice([{ gross: 25000 }])).json();
    const nc = (await call("POST", `/api/arca/invoices/${inv.id}/credit-note`, { id: randomUUID() })).json();
    expect(nc).toMatchObject({ kind: "nota_credito", status: "autorizada", cbteTipo: 13, numero: 1, total: 25000, associatedId: inv.id });
  });
});

describe("responsable inscripto", () => {
  it("factura B a consumidor final, con IVA por alícuota que cierra exacto", async () => {
    await setup("responsable_inscripto");
    const inv = (await invoice([{ gross: 121000, ivaRate: 21 }, { gross: 11050, ivaRate: 10.5 }], consumidorFinal, { discount: 1000 })).json();
    expect(inv).toMatchObject({ status: "autorizada", cbteTipo: 6 });
    expect(inv.amounts.neto + inv.amounts.iva).toBe(inv.total);
    expect(inv.amounts.groups.map((g: { rate: number }) => g.rate)).toEqual([21, 10.5]);
  });

  it("factura A a otro inscripto con CUIT; sin CUIT no se puede", async () => {
    await setup("responsable_inscripto");
    const sinCuit = await invoice([{ gross: 1000 }], { docTipo: 96, docNro: "30111222", condicion: 1 });
    expect(sinCuit.statusCode).toBe(400);
    expect(sinCuit.json().message).toMatch(/CUIT/);
    const a = (await invoice([{ gross: 121000 }], { docTipo: 80, docNro: "30-71234567-1", condicion: 1, name: "Proveedor SA" })).json();
    expect(a).toMatchObject({ status: "autorizada", cbteTipo: 1, receiver: { docNro: "30712345671", name: "Proveedor SA" } });
  });

  it("desde $10.000.000 hay que identificar al comprador", async () => {
    await setup("responsable_inscripto");
    const res = await invoice([{ gross: 10_000_000_00 }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/identificar/);
    const ok = await invoice([{ gross: 10_000_000_00 }], { docTipo: 96, docNro: "30111222", condicion: 5 });
    expect(ok.json().status).toBe("autorizada");
  });
});

describe("sin configurar", () => {
  it("avisa qué falta", async () => {
    const res = await invoice([{ gross: 1000 }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/no está configurada/);
  });
});
