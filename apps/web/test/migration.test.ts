import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";

describe("migración desde la Fase 1", () => {
  it("convierte proveedores en entidades, crea el dueño y separa la configuración", async () => {
    // Una base como la que dejó la Fase 1.
    const v1 = new Dexie("misventas");
    v1.version(1).stores({
      products: "id, name, *barcodes, code, category, supplier, updatedAt",
      stockMovements: "id, productId, createdAt, type, refId",
      sales: "id, number, createdAt, cashSessionId, status",
      cashSessions: "id, status, openedAt",
      cashMovements: "id, cashSessionId, createdAt",
      heldCarts: "id, createdAt",
      meta: "key",
    });
    await v1.table("products").bulkAdd([
      { id: "p1", name: "Coca", barcodes: [], category: "Bebidas", supplier: "Distribuidora Norte", price: 1, cost: 1, stock: 3, minStock: 1, trackStock: true, favorite: false, active: true, createdAt: 1, updatedAt: 1 },
      { id: "p2", name: "Agua", barcodes: [], category: "Bebidas", supplier: "Distribuidora Norte", price: 1, cost: 1, stock: 3, minStock: 1, trackStock: true, favorite: false, active: true, createdAt: 1, updatedAt: 1 },
      { id: "p3", name: "Chicle", barcodes: [], category: "Golosinas", supplier: "", price: 1, cost: 1, stock: 3, minStock: 1, trackStock: true, favorite: false, active: true, createdAt: 1, updatedAt: 1 },
    ]);
    await v1.table("cashSessions").add({ id: "c1", status: "abierta", openedAt: 5, openedBy: "Marta", openingAmount: 0 });
    await v1.table("sales").add({ id: "s1", number: "D01-000001", createdAt: 6, cashSessionId: "c1", cashier: "Marta", items: [], subtotal: 0, discount: 0, total: 0, payments: [], change: 0, status: "completada" });
    await v1.table("meta").put({ key: "settings", value: { businessName: "Kiosco Marta", textSize: "grande", theme: "oscuro", onboarded: true, enabledMethods: ["efectivo", "debito"] } });
    v1.close();

    const { db, getDeviceId } = await import("../src/db");
    await db.open();

    const suppliers = await db.suppliers.toArray();
    expect(suppliers.map((s) => s.name)).toEqual(["Distribuidora Norte"]);
    const products = await db.products.toArray();
    expect(products.map((p) => p.supplierId)).toEqual([suppliers[0]!.id, suppliers[0]!.id, null]);
    expect(products.every((p) => !("supplier" in p))).toBe(true);

    const users = await db.users.toArray();
    expect(users).toMatchObject([{ name: "Marta", role: "dueno", pinHash: null, active: true }]);

    const deviceId = await getDeviceId();
    expect(await db.cashSessions.get("c1")).toMatchObject({ deviceId, openedById: users[0]!.id });
    expect(await db.sales.get("s1")).toMatchObject({ deviceId, userId: users[0]!.id });

    expect(await db.business.get("business")).toMatchObject({ businessName: "Kiosco Marta", enabledMethods: ["efectivo", "debito", "fiado"] });
    expect((await db.meta.get("settings"))?.value).toMatchObject({ textSize: "grande", theme: "oscuro", onboarded: true });
  });
});
