import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/app.ts";
import { openDb, rows, type DbHandle } from "../src/db.ts";
import { SyncHub } from "../src/events.ts";
import { verifyWebhookSignature } from "../src/mercadopago.ts";
import { FAKE_POS_ID, FAKE_TERMINAL_ID, FAKE_TOKEN, startFakeMercadoPago } from "./fake-mercadopago.ts";

let handle: DbHandle;
let fake: Awaited<ReturnType<typeof startFakeMercadoPago>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let hub: SyncHub;
let token: string;

beforeAll(async () => {
  handle = await openDb({ url: process.env.TEST_DATABASE_URL });
  fake = await startFakeMercadoPago();
});
afterAll(async () => {
  await fake.close();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`TRUNCATE mp_charges, mp_accounts, entities, devices, accounts, tenants`);
  hub = new SyncHub();
  app = await buildApp({ db: handle.db, hub, rateLimit: false, appSecret: "secreto-de-prueba", mpApiUrl: fake.url });
  token = await register("duenio@kiosco.com");
});
afterEach(async () => {
  await app.close();
});

async function register(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { businessName: "Kiosco", email, password: "clave-segura", deviceName: "PC" } });
  return res.json().device.token as string;
}

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, t = token) =>
  app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${t}` } });

async function connect(extra: Record<string, unknown> = {}) {
  const res = await call("PUT", "/api/mp/config", { accessToken: FAKE_TOKEN, externalPosId: FAKE_POS_ID, ...extra });
  expect(res.statusCode).toBe(200);
}

describe("configuración de Mercado Pago", () => {
  it("valida el token contra Mercado Pago y lo guarda cifrado", async () => {
    const bad = await call("PUT", "/api/mp/config", { accessToken: "APP_USR-token-que-no-sirve" });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().message).toMatch(/rechazó el token/);

    await connect();
    const config = (await call("GET", "/api/mp/config")).json();
    expect(config).toMatchObject({ available: true, connected: true, nickname: "KIOSCO_PRUEBA", externalPosId: FAKE_POS_ID });

    const [stored] = rows<{ access_token_enc: string }>(await handle.db.execute(sql`SELECT access_token_enc FROM mp_accounts`));
    expect(stored!.access_token_enc).not.toContain(FAKE_TOKEN);
  });

  it("lista cajas QR y posnets, y pasa el posnet a modo integrado", async () => {
    await connect();
    const pos = (await call("GET", "/api/mp/pos")).json();
    expect(pos.map((p: { externalId: string | null }) => p.externalId)).toEqual([FAKE_POS_ID, null]);
    expect((await call("GET", "/api/mp/terminals")).json()[0]).toMatchObject({ id: FAKE_TERMINAL_ID, operatingMode: "STANDALONE" });
    expect((await call("POST", `/api/mp/terminals/${FAKE_TERMINAL_ID}/pdv`)).statusCode).toBe(200);
    expect((await call("GET", "/api/mp/terminals")).json()[0].operatingMode).toBe("PDV");
  });

  it("crea el local y la caja QR con ids propios y la deja elegida", async () => {
    await call("PUT", "/api/mp/config", { accessToken: FAKE_TOKEN });
    const address = { storeName: "Kiosco Don Pepe", streetName: "Av. Corrientes", streetNumber: "1234", city: "CABA", state: "Capital Federal", latitude: -34.6037, longitude: -58.3816 };
    const res = await call("POST", "/api/mp/qr-setup", address);
    expect(res.statusCode).toBe(200);
    const { externalPosId } = res.json();
    expect(externalPosId).toMatch(/^MV[A-Z0-9]{12}CAJA1$/);
    expect((await call("GET", "/api/mp/config")).json().externalPosId).toBe(externalPosId);
    const charge = await call("POST", "/api/mp/charges", { kind: "qr", amount: 1000 });
    expect(charge.json().status).toBe("pendiente");
    // Repetirlo no duplica: Mercado Pago avisa que la caja ya existe.
    expect((await call("POST", "/api/mp/qr-setup", address)).json().message).toMatch(/Ya existe una caja/);
  });

  it("en la versión de prueba no se puede conectar una cuenta real", async () => {
    const demo = await buildApp({ db: handle.db, rateLimit: false, appSecret: "x", mpApiUrl: fake.url, demo: true });
    const headers = { authorization: `Bearer ${token}` };
    const res = await demo.inject({ method: "PUT", url: "/api/mp/config", payload: { accessToken: FAKE_TOKEN }, headers });
    expect(res.statusCode).toBe(403);
    expect((await demo.inject({ method: "GET", url: "/api/mp/config", headers })).json()).toMatchObject({ available: false, demo: true });
    const info = await demo.inject({ method: "GET", url: "/api/info" });
    expect(info.json()).toEqual({ demo: true });
    expect(info.headers["x-robots-tag"]).toBe("noindex, nofollow");
    await demo.close();
  });

  it("sin APP_SECRET en el servidor no se puede conectar", async () => {
    const noSecret = await buildApp({ db: handle.db, rateLimit: false, mpApiUrl: fake.url });
    const res = await noSecret.inject({ method: "PUT", url: "/api/mp/config", payload: { accessToken: FAKE_TOKEN }, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
    await noSecret.close();
  });
});

describe("cobro con QR", () => {
  it("crea la orden con montos en texto, espera y se entera cuando el cliente paga", async () => {
    await connect();
    const events: { event: string; data: { status: string } }[] = [];
    hub.subscribe(rows<{ tenant_id: string }>(await handle.db.execute(sql`SELECT tenant_id FROM devices LIMIT 1`))[0]!.tenant_id, {
      deviceId: "otra-caja",
      send: (event, data) => events.push({ event, data: data as { status: string } }),
    });

    const id = randomUUID();
    const created = (await call("POST", "/api/mp/charges", { kind: "qr", amount: 435050, id })).json();
    expect(created).toMatchObject({ id, kind: "qr", amount: 435050, status: "pendiente" });
    expect(created.qrData).toMatch(/^000201/);

    const sent = fake.requests.find((r) => r.method === "POST" && r.url === "/v1/orders" && (r.body as { external_reference?: string }).external_reference === id)!.body as Record<string, any>;
    expect(sent).toMatchObject({ type: "qr", total_amount: "4350.50", external_reference: id, config: { qr: { external_pos_id: FAKE_POS_ID } } });

    // Reintentar con el mismo id no crea otra orden.
    await call("POST", "/api/mp/charges", { kind: "qr", amount: 435050, id });
    expect([...fake.orders.values()].filter((o) => o.external_reference === id)).toHaveLength(1);

    fake.pay(id);
    await new Promise((r) => setTimeout(r, 2100)); // el estado se consulta a MP como mucho cada 2 s
    const paid = (await call("GET", `/api/mp/charges/${id}`)).json();
    expect(paid).toMatchObject({ status: "pagado", mpStatus: "processed", paymentId: expect.stringMatching(/^PAY01FAKE/) });
    expect(events).toContainEqual(expect.objectContaining({ event: "payment", data: expect.objectContaining({ status: "pagado" }) }));
  });

  it("el webhook actualiza el cobro al instante (y valida la firma si hay secreto)", async () => {
    await connect({ webhookSecret: "secreto-webhook" });
    const id = randomUUID();
    await call("POST", "/api/mp/charges", { kind: "qr", amount: 100000, id });
    const order = [...fake.orders.values()].find((o) => o.external_reference === id)!;
    fake.pay(id);

    const forged = await app.inject({
      method: "POST",
      url: "/api/webhooks/mercadopago",
      headers: { "x-signature": "ts=1,v1=abc", "x-request-id": "r1" },
      payload: { type: "order", data: { id: order.id } },
    });
    expect(forged.statusCode).toBe(401);

    const ts = String(Date.now());
    const v1 = createHmac("sha256", "secreto-webhook").update(`id:${order.id.toLowerCase()};request-id:r2;ts:${ts};`).digest("hex");
    const ok = await app.inject({
      method: "POST",
      url: `/api/webhooks/mercadopago?data.id=${order.id}&type=order`,
      headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": "r2" },
      payload: { action: "order.processed", type: "order", data: { id: order.id } },
    });
    expect(ok.statusCode).toBe(200);
    const [row] = rows<{ status: string }>(await handle.db.execute(sql`SELECT status FROM mp_charges WHERE id = ${id}`));
    expect(row!.status).toBe("pagado");
  });

  it("un webhook de una orden desconocida se ignora sin error", async () => {
    const res = await app.inject({ method: "POST", url: "/api/webhooks/mercadopago", payload: { type: "order", data: { id: "ORD-NO-EXISTE" } } });
    expect(res.statusCode).toBe(200);
  });

  it("cancelar un QR pendiente", async () => {
    await connect();
    const id = randomUUID();
    await call("POST", "/api/mp/charges", { kind: "qr", amount: 5000, id });
    const canceled = (await call("POST", `/api/mp/charges/${id}/cancel`)).json();
    expect(canceled).toMatchObject({ status: "fallido", mpStatus: "canceled", message: "Se canceló el cobro." });
  });

  it("si se desconecta Mercado Pago con un cobro en curso, la caja deja de esperar", async () => {
    await connect();
    const id = randomUUID();
    await call("POST", "/api/mp/charges", { kind: "qr", amount: 5000, id });
    await call("DELETE", "/api/mp/config");
    await new Promise((r) => setTimeout(r, 2100));
    expect((await call("GET", `/api/mp/charges/${id}`)).json()).toMatchObject({ status: "fallido", message: expect.stringMatching(/se desconectó/) });
  });

  it("sin caja QR elegida avisa qué falta", async () => {
    await call("PUT", "/api/mp/config", { accessToken: FAKE_TOKEN });
    const res = await call("POST", "/api/mp/charges", { kind: "qr", amount: 5000 });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/caja QR/);
  });
});

describe("cobro con Point", () => {
  it("manda el cobro al posnet, avisa si está ocupado y si lo rechazan", async () => {
    await connect({ terminalId: FAKE_TERMINAL_ID });
    await call("POST", `/api/mp/terminals/${FAKE_TERMINAL_ID}/pdv`);
    const first = randomUUID();
    const created = (await call("POST", "/api/mp/charges", { kind: "point", amount: 250000, id: first })).json();
    expect(created.status).toBe("pendiente");
    const sent = fake.requests.filter((r) => r.url === "/v1/orders").at(-1)!.body as Record<string, any>;
    expect(sent).toMatchObject({ type: "point", config: { point: { terminal_id: FAKE_TERMINAL_ID } }, transactions: { payments: [{ amount: "2500.00" }] } });
    expect(sent.total_amount).toBeUndefined();

    const busy = await call("POST", "/api/mp/charges", { kind: "point", amount: 1000 });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().message).toMatch(/otro cobro pendiente/);

    fake.setStatus(first, "at_terminal");
    const cancel = await call("POST", `/api/mp/charges/${first}/cancel`);
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().message).toMatch(/cancelalo desde el aparato/);

    fake.setStatus(first, "failed", "rejected");
    await new Promise((r) => setTimeout(r, 2100));
    expect((await call("GET", `/api/mp/charges/${first}`)).json()).toMatchObject({ status: "fallido", message: expect.stringMatching(/rechazado/) });
  });
});

describe("aislamiento", () => {
  it("un comercio no ve los cobros de otro", async () => {
    await connect();
    const id = randomUUID();
    await call("POST", "/api/mp/charges", { kind: "qr", amount: 5000, id });
    const other = await register("otro@kiosco.com");
    expect((await call("GET", `/api/mp/charges/${id}`, undefined, other)).statusCode).toBe(404);
  });
});

describe("firma de webhooks", () => {
  it("arma el manifiesto con el id en minúsculas y omite lo que falta", () => {
    const ts = "1742505638683";
    const sig = createHmac("sha256", "s").update(`id:ord01abc;ts:${ts};`).digest("hex");
    expect(verifyWebhookSignature({ secret: "s", signature: `ts=${ts},v1=${sig}`, dataId: "ORD01ABC" })).toBe(true);
    expect(verifyWebhookSignature({ secret: "otro", signature: `ts=${ts},v1=${sig}`, dataId: "ORD01ABC" })).toBe(false);
    expect(verifyWebhookSignature({ secret: "s", signature: undefined, dataId: "ORD01ABC" })).toBe(false);
  });
});
