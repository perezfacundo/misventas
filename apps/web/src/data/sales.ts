import { cartSubtotal, cartTotal, formatReceiptNumber, uuidv7, type Cart, type Cents, type Payment } from "@misventas/core";
import { db, getDeviceId, type Sale, type User } from "../db";
import { getSettings, nextReceiptNumber } from "./settings";
import { recordMovement } from "./products";
import { getOpenSession } from "./cash";

const fiadoAmount = (payments: readonly Payment[]) => payments.filter((p) => p.method === "fiado").reduce((s, p) => s + p.amount, 0);

/** Guarda la venta, descuenta stock y anota el fiado en una sola transacción: o se registra todo, o nada. */
export async function completeSale(
  cart: Cart,
  payments: Payment[],
  change: Cents,
  ctx: { user: Pick<User, "id" | "name">; customerId?: string },
): Promise<Sale> {
  const fiado = fiadoAmount(payments);
  if (fiado > 0 && !ctx.customerId) throw new Error("Elegí a quién se le fía.");
  return db.transaction(
    "rw",
    [db.sales, db.products, db.stockMovements, db.meta, db.cashSessions, db.accountMovements, db.business],
    async () => {
      const session = await getOpenSession();
      if (!session) throw new Error("No hay una caja abierta.");
      const settings = await getSettings();
      const sale: Sale = {
        id: uuidv7(),
        number: formatReceiptNumber(settings.devicePrefix, await nextReceiptNumber()),
        createdAt: Date.now(),
        deviceId: await getDeviceId(),
        cashSessionId: session.id,
        userId: ctx.user.id,
        cashier: ctx.user.name,
        customerId: fiado > 0 ? ctx.customerId : undefined,
        items: cart.lines,
        subtotal: cartSubtotal(cart),
        discount: cart.discount,
        total: cartTotal(cart),
        payments,
        change,
        status: "completada",
      };
      await db.sales.add(sale);
      for (const line of cart.lines) {
        if (!line.productId) continue;
        const product = await db.products.get(line.productId);
        if (product?.trackStock) await recordMovement(line.productId, "venta", line.quantity, { refId: sale.id });
      }
      if (fiado > 0) {
        await db.accountMovements.add({
          id: uuidv7(), customerId: ctx.customerId!, type: "compra", amount: fiado, saleId: sale.id,
          createdAt: sale.createdAt, userName: ctx.user.name,
        });
      }
      return sale;
    },
  );
}

/** Anula la venta, devuelve el stock y descuenta el fiado. Solo se permite mientras su caja sigue abierta. */
export async function voidSale(saleId: string, reason: string, userName: string): Promise<void> {
  await db.transaction("rw", [db.sales, db.products, db.stockMovements, db.cashSessions, db.accountMovements], async () => {
    const sale = await db.sales.get(saleId);
    if (!sale || sale.status === "anulada") return;
    const session = await db.cashSessions.get(sale.cashSessionId);
    if (session?.status !== "abierta") throw new Error("Solo se pueden anular ventas de una caja abierta.");
    await db.sales.update(saleId, { status: "anulada", voidedAt: Date.now(), voidReason: reason, voidedBy: userName });
    const movements = await db.stockMovements.where("refId").equals(saleId).toArray();
    for (const m of movements) {
      if (m.type !== "venta") continue;
      await recordMovement(m.productId, "anulacion", 0, { refId: saleId, delta: -m.delta, note: reason });
    }
    const fiado = fiadoAmount(sale.payments);
    if (fiado > 0 && sale.customerId) {
      await db.accountMovements.add({
        id: uuidv7(), customerId: sale.customerId, type: "anulacion", amount: -fiado, saleId,
        note: reason, createdAt: Date.now(), userName,
      });
    }
  });
}

export function salesBetween(from: number, to: number): Promise<Sale[]> {
  return db.sales.where("createdAt").between(from, to, true, false).reverse().toArray();
}

export function startOfDay(date: Date | number = new Date()): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
