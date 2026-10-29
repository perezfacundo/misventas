import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, redactUrl } from "../src/app.ts";
import { openDb, type DbHandle } from "../src/db.ts";
import { SyncHub } from "../src/events.ts";
import { sql } from "drizzle-orm";

let handle: DbHandle;
let app: Awaited<ReturnType<typeof buildApp>>;

// Un PGlite en memoria por archivo (abrirlo tarda); entre tests se vacían las tablas.
// Con TEST_DATABASE_URL corren contra un PostgreSQL real (el driver de producción).
beforeAll(async () => {
  handle = await openDb({ url: process.env.TEST_DATABASE_URL });
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`TRUNCATE mp_charges, mp_accounts, entities, devices, accounts, tenants CASCADE`);
  app = await buildApp({ db: handle.db, rateLimit: false });
});
afterEach(async () => {
  await app.close();
});

async function register(email = "duenio@kiosco.com", businessName = "Kiosco Uno") {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { businessName, email, password: "clave-segura", deviceName: "PC del mostrador" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { tenant: { id: string }; device: { id: string; prefix: string; token: string } };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function push(token: string, changes: unknown[]) {
  return app.inject({ method: "POST", url: "/api/sync/push", headers: auth(token), payload: { changes } });
}
async function pull(token: string, since = 0) {
  const res = await app.inject({ method: "GET", url: `/api/sync/pull?since=${since}`, headers: auth(token) });
  return res.json() as { changes: { table: string; id: string; data: Record<string, unknown>; seq: number }[]; cursor: number; hasMore: boolean };
}

describe("cuentas y dispositivos", () => {
  it("registrar crea el comercio y el primer dispositivo D01; login vincula D02", async () => {
    const reg = await register();
    expect(reg.device.prefix).toBe("D01");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "DUENIO@kiosco.com ", password: "clave-segura", deviceName: "Celular" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().device.prefix).toBe("D02");
    expect(login.json().tenant.id).toBe(reg.tenant.id);
  });

  it("rechaza email repetido, contraseña corta y credenciales incorrectas", async () => {
    await register();
    const dup = await app.inject({ method: "POST", url: "/api/auth/register", payload: { businessName: "X", email: "duenio@kiosco.com", password: "otra-clave", deviceName: "PC" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toMatch(/Ya existe/);
    const weak = await app.inject({ method: "POST", url: "/api/auth/register", payload: { businessName: "X", email: "nuevo@kiosco.com", password: "123", deviceName: "PC" } });
    expect(weak.statusCode).toBe(400);
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "duenio@kiosco.com", password: "incorrecta", deviceName: "PC" } });
    expect(bad.statusCode).toBe(401);
  });

  it("sin token o con token inválido no hay acceso", async () => {
    expect((await app.inject({ method: "GET", url: "/api/sync/pull" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/sync/pull", headers: auth("inventado") })).statusCode).toBe(401);
  });

  it("un dispositivo desvinculado pierde el acceso", async () => {
    const reg = await register();
    const login = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "duenio@kiosco.com", password: "clave-segura", deviceName: "Celular" } })).json();
    const list = await app.inject({ method: "GET", url: "/api/devices", headers: auth(reg.device.token) });
    expect(list.json()).toHaveLength(2);
    await app.inject({ method: "DELETE", url: `/api/devices/${login.device.id}`, headers: auth(reg.device.token) });
    const res = await app.inject({ method: "GET", url: "/api/sync/pull", headers: auth(login.device.token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("device_revoked");
  });
});

describe("sincronización", () => {
  it("fusiona por campo: cada dispositivo pisa solo lo que cambió", async () => {
    const a = await register();
    const b = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "duenio@kiosco.com", password: "clave-segura", deviceName: "Celular" } })).json();
    await push(a.device.token, [{ table: "products", id: "coca", patch: { name: "Coca 500", price: 150000, category: "Bebidas" } }]);
    await push(a.device.token, [{ table: "products", id: "coca", patch: { price: 160000 } }]);
    await push(b.device.token, [{ table: "products", id: "coca", patch: { category: "Gaseosas" } }]);
    const { changes } = await pull(b.device.token);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.data).toEqual({ name: "Coca 500", price: 160000, category: "Gaseosas" });
  });

  it("el cursor trae solo lo nuevo y pagina", async () => {
    const a = await register();
    const first = await push(a.device.token, [
      { table: "stockMovements", id: "m1", patch: { productId: "coca", delta: 10 } },
      { table: "stockMovements", id: "m2", patch: { productId: "coca", delta: -1 } },
    ]);
    const { cursor } = await pull(a.device.token);
    expect(cursor).toBe(first.json().seq);
    await push(a.device.token, [{ table: "stockMovements", id: "m3", patch: { productId: "coca", delta: -1 } }]);
    const next = await pull(a.device.token, cursor);
    expect(next.changes.map((c) => c.id)).toEqual(["m3"]);

    const page = await app.inject({ method: "GET", url: "/api/sync/pull?since=0&limit=2", headers: auth(a.device.token) });
    expect(page.json().hasMore).toBe(true);
    expect(page.json().changes).toHaveLength(2);
  });

  it("reenviar el mismo cambio no duplica (reintentos seguros)", async () => {
    const a = await register();
    const change = { table: "sales", id: "v1", patch: { total: 100000, status: "completada" } };
    await push(a.device.token, [change]);
    await push(a.device.token, [change]);
    expect((await pull(a.device.token)).changes).toHaveLength(1);
  });

  it("cada comercio ve solo sus datos", async () => {
    const a = await register("a@kiosco.com", "Kiosco A");
    const b = await register("b@kiosco.com", "Kiosco B");
    await push(a.device.token, [{ table: "products", id: "secreto", patch: { name: "Solo de A" } }]);
    await push(b.device.token, [{ table: "products", id: "secreto", patch: { name: "De B" } }]);
    expect((await pull(b.device.token)).changes.map((c) => c.data.name)).toEqual(["De B"]);
    expect((await pull(a.device.token)).changes.map((c) => c.data.name)).toEqual(["Solo de A"]);
  });

  it("rechaza tablas desconocidas", async () => {
    const a = await register();
    const res = await push(a.device.token, [{ table: "accounts", id: "x", patch: { email: "hack" } }]);
    expect(res.statusCode).toBe(400);
  });
});

describe("avisos en tiempo real", () => {
  it("avisa a los otros dispositivos del mismo comercio, no al que escribió", () => {
    const hub = new SyncHub();
    const got: string[] = [];
    hub.subscribe("t1", { deviceId: "d1", send: () => got.push("d1") });
    hub.subscribe("t1", { deviceId: "d2", send: () => got.push("d2") });
    hub.subscribe("t2", { deviceId: "d3", send: () => got.push("d3") });
    hub.publish("t1", "d1", 5);
    expect(got).toEqual(["d2"]);
  });
});

describe("migraciones", () => {
  it("se pueden correr varias veces sobre la misma base", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "misventas-"));
    try {
      const first = await openDb({ dataDir: dir });
      await first.close();
      const second = await openDb({ dataDir: dir });
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("logs", () => {
  it("no escriben el token del dispositivo", () => {
    expect(redactUrl("/api/sync/events?token=abc123")).toBe("/api/sync/events?token=***");
    expect(redactUrl("/api/x?a=1&token=abc&b=2")).toBe("/api/x?a=1&token=***&b=2");
    expect(redactUrl("/api/sync/pull?since=4")).toBe("/api/sync/pull?since=4");
  });
});
