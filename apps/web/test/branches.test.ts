import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, setCurrentBranchId } from "../src/db";
import "../src/sync/tracking";
import { remoteTransaction } from "../src/sync/tracking";
import { applyRemote } from "../src/sync/engine";
import { cancelTransfer, receiveTransfer, sendTransfer } from "../src/data/branches";
import { discardLot, addLot } from "../src/data/lots";
import { recordMovement } from "../src/data/products";

const product = (id: string) => ({
  id, name: id, barcodes: [], category: "", supplierId: null, price: 1000, cost: null,
  stock: 0, minStock: 0, trackStock: true, favorite: false, active: true, createdAt: 1, updatedAt: 1,
});

beforeEach(async () => {
  setCurrentBranchId("principal");
  await db.delete();
  await db.open();
  await remoteTransaction(["products"], () => db.products.add(product("coca")));
});

const stock = async () => (await db.products.get("coca"))!.stock;

describe("stock por sucursal", () => {
  it("al sincronizar, cada caja suma solo los movimientos de su sucursal (sin dato = principal)", async () => {
    const movs = [
      { table: "stockMovements" as const, id: "m1", data: { productId: "coca", delta: 24, type: "compra", createdAt: 1 }, seq: 1 },
      { table: "stockMovements" as const, id: "m2", data: { productId: "coca", delta: 10, type: "compra", branchId: "centro", createdAt: 2 }, seq: 2 },
      { table: "stockMovements" as const, id: "m3", data: { productId: "coca", delta: -1, type: "venta", branchId: "centro", createdAt: 3 }, seq: 3 },
    ];
    await applyRemote(movs, 3);
    expect(await stock()).toBe(24);
    setCurrentBranchId("centro");
    await applyRemote([{ table: "stockMovements", id: "m4", data: { productId: "coca", delta: -1, type: "venta", branchId: "centro", createdAt: 4 }, seq: 4 }], 4);
    expect(await stock()).toBe(8);
  });
});

describe("transferencias", () => {
  it("envío, recepción (con faltante) y que no se pueda recibir dos veces", async () => {
    await db.transaction("rw", [db.products, db.stockMovements], () => recordMovement("coca", "compra", 20));
    const t = await sendTransfer({ toBranchId: "centro", userName: "Ana", items: [{ productId: "coca", name: "Coca", quantity: 6 }] });
    expect(await stock()).toBe(14);

    await expect(receiveTransfer(t, { coca: 6 }, "Luis")).rejects.toThrow(/otra sucursal/);
    setCurrentBranchId("centro");
    await receiveTransfer(t, { coca: 5 }, "Luis");
    const movs = await db.stockMovements.where("refId").equals(t.id).toArray();
    expect(movs.map((m) => [m.type, m.delta, m.branchId])).toEqual([["transferencia_salida", -6, "principal"], ["transferencia_entrada", 5, "centro"]]);
    expect((await db.transfers.get(t.id))).toMatchObject({ status: "recibida", receivedBy: "Luis", items: [{ quantity: 6, received: 5 }] });
    await expect(receiveTransfer(t, { coca: 5 }, "Luis")).rejects.toThrow(/ya se recibió/);
  });

  it("cancelar un envío devuelve la mercadería", async () => {
    await db.transaction("rw", [db.products, db.stockMovements], () => recordMovement("coca", "compra", 10));
    const t = await sendTransfer({ toBranchId: "centro", userName: "Ana", items: [{ productId: "coca", name: "Coca", quantity: 4 }] });
    await cancelTransfer(t);
    expect(await stock()).toBe(10);
    expect((await db.transfers.get(t.id))?.status).toBe("cancelada");
  });

  it("no se puede enviar a la misma sucursal", async () => {
    await expect(sendTransfer({ toBranchId: "principal", userName: "Ana", items: [{ productId: "coca", name: "Coca", quantity: 1 }] })).rejects.toThrow(/otra sucursal/);
  });
});

describe("vencimientos", () => {
  it("dar de baja un lote descuenta stock como merma y no se cuenta dos veces", async () => {
    await db.transaction("rw", [db.products, db.stockMovements, db.lots], async () => {
      await recordMovement("coca", "compra", 12);
      await addLot({ productId: "coca", expiresAt: "2026-10-30", quantity: 12 });
    });
    const [lot] = await db.lots.toArray();
    await discardLot(lot!, 3);
    expect(await stock()).toBe(9);
    expect((await db.lots.get(lot!.id))?.discarded).toBe(3);
    const [merma] = await db.stockMovements.where("type").equals("merma").toArray();
    expect(merma).toMatchObject({ delta: -3, refId: lot!.id });
  });
});
