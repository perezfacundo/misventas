import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import "../src/sync/tracking";
import { remoteTransaction } from "../src/sync/tracking";
import { applyRemote, syncNow } from "../src/sync/engine";

const product = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: "Coca", barcodes: [], category: "Bebidas", supplierId: null, price: 150000, cost: 90000,
  stock: 0, minStock: 2, trackStock: true, favorite: false, active: true, createdAt: 1, updatedAt: 1, ...extra,
});

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe("cambios pendientes", () => {
  it("un registro nuevo queda pendiente completo", async () => {
    await db.products.add(product("p1"));
    const p = await db.products.get("p1");
    expect(p).toMatchObject({ _dirty: 1, _df: ["*"], _rev: 1 });
  });

  it("una edición marca solo los campos tocados", async () => {
    await remoteTransaction(["products"], () => db.products.add(product("p1")));
    await db.products.update("p1", { price: 160000 });
    await db.products.update("p1", { name: "Coca-Cola" });
    expect(await db.products.get("p1")).toMatchObject({ _dirty: 1, _df: ["price", "name"], _rev: 2 });
  });

  it("cambiar solo el stock (proyección local) no genera nada para subir", async () => {
    await remoteTransaction(["products"], () => db.products.add(product("p1")));
    await db.products.update("p1", { stock: 5 });
    const p = await db.products.get("p1");
    expect(p?._dirty).toBeUndefined();
    expect(p?.stock).toBe(5);
  });

  it("lo que baja del servidor no queda pendiente", async () => {
    await applyRemote([{ table: "products", id: "p9", data: product("p9"), seq: 1 }], 1);
    expect((await db.products.get("p9"))?._dirty).toBeUndefined();
    expect((await db.meta.get("syncCursor"))?.value).toBe(1);
  });
});

describe("aplicar cambios remotos", () => {
  it("no pisa los campos editados localmente que todavía no se subieron", async () => {
    await remoteTransaction(["products"], () => db.products.add(product("p1")));
    await db.products.update("p1", { price: 170000 }); // local, sin subir
    await applyRemote([{ table: "products", id: "p1", data: { price: 999, name: "Coca 500 ml" }, seq: 2 }], 2);
    expect(await db.products.get("p1")).toMatchObject({ price: 170000, name: "Coca 500 ml", _dirty: 1 });
  });

  it("recalcula el stock con los movimientos que llegan de otras cajas", async () => {
    await applyRemote(
      [
        { table: "products", id: "p1", data: product("p1", { stock: 999 }), seq: 1 },
        { table: "stockMovements", id: "m1", data: { productId: "p1", delta: 10, type: "compra", createdAt: 1 }, seq: 2 },
        { table: "stockMovements", id: "m2", data: { productId: "p1", delta: -1, type: "venta", createdAt: 2 }, seq: 3 },
      ],
      3,
    );
    expect((await db.products.get("p1"))?.stock).toBe(9); // el stock remoto se ignora
  });
});

describe("subir", () => {
  it("manda solo lo pendiente y lo limpia al confirmar", async () => {
    await db.meta.put({ key: "cloud", value: { token: "t", tenantId: "x", tenantName: "K", serverDeviceId: "d", prefix: "D01", email: "a@b.c", linkedAt: 0 } });
    await remoteTransaction(["products"], () => db.products.add(product("p1")));
    await db.products.update("p1", { price: 180000, stock: 3 });
    const sent: unknown[] = [];
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/push")) sent.push(JSON.parse(String(init?.body)));
      const body = url.includes("/push") ? { seq: 1 } : { changes: [], cursor: 0, hasMore: false };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    await syncNow();
    expect(sent).toEqual([{ changes: [{ table: "products", id: "p1", patch: { price: 180000 } }] }]);
    expect((await db.products.get("p1"))?._dirty).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
