import { useLiveQuery } from "dexie-react-hooks";
import { uuidv7, type Cents } from "@misventas/core";
import { currentBranchId, db, type Purchase, type Supplier } from "../db";
import { recordMovement } from "./products";
import { addLot } from "./lots";
import { addCashMovement, getOpenSession } from "./cash";

const EMPTY: Supplier[] = [];

export function useSuppliers(): Supplier[] {
  return useLiveQuery(
    () => db.suppliers.filter((s) => s.active).toArray().then((ss) => ss.sort((a, b) => a.name.localeCompare(b.name, "es"))),
    [],
    EMPTY,
  );
}

export type SupplierInput = Pick<Supplier, "name" | "phone" | "contact" | "visitDays" | "notes">;

export async function createSupplier(input: SupplierInput): Promise<Supplier> {
  const now = Date.now();
  const supplier: Supplier = { ...input, name: input.name.trim(), id: uuidv7(), active: true, createdAt: now, updatedAt: now };
  await db.suppliers.add(supplier);
  return supplier;
}

export async function updateSupplier(id: string, patch: Partial<SupplierInput & { active: boolean }>): Promise<void> {
  await db.suppliers.update(id, { ...patch, updatedAt: Date.now() });
}

/** Busca un proveedor por nombre (sin distinguir mayúsculas) o lo crea. */
export async function findOrCreateSupplier(name: string): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;
  const existing = (await db.suppliers.toArray()).find((s) => s.active && s.name.toLowerCase() === clean.toLowerCase());
  return existing?.id ?? (await createSupplier({ name: clean, phone: "", contact: "", visitDays: [], notes: "" })).id;
}

export interface PurchaseLine {
  productId: string;
  name: string;
  quantity: number;
  /** Nuevo costo unitario, si cambió. */
  cost: Cents | null;
  costChanged: boolean;
  /** Vencimiento del lote (AAAA-MM-DD), para productos que lo controlan. */
  expiresAt?: string;
}

/** Ingreso de mercadería: suma stock, actualiza costos y, si se pagó de la caja, registra el retiro. */
export async function registerPurchase(input: {
  supplierId: string | null;
  lines: PurchaseLine[];
  paidFromCash: boolean;
  userName: string;
}): Promise<Purchase> {
  const total = input.lines.reduce((s, l) => s + (l.cost ?? 0) * l.quantity, 0);
  const purchase: Purchase = {
    id: uuidv7(),
    supplierId: input.supplierId,
    items: input.lines.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, cost: l.cost })),
    total,
    paidFromCash: input.paidFromCash,
    createdAt: Date.now(),
    userName: input.userName,
  };
  await db.transaction("rw", [db.products, db.stockMovements, db.purchases, db.cashSessions, db.cashMovements, db.suppliers, db.meta, db.lots], async () => {
    await db.purchases.add({ ...purchase, branchId: currentBranchId() });
    for (const line of input.lines) {
      if (line.costChanged) await db.products.update(line.productId, { cost: line.cost, updatedAt: Date.now() });
      await recordMovement(line.productId, "compra", line.quantity, { refId: purchase.id });
      if (line.expiresAt) await addLot({ productId: line.productId, expiresAt: line.expiresAt, quantity: line.quantity, purchaseId: purchase.id });
    }
    if (input.paidFromCash && total > 0) {
      const session = await getOpenSession();
      if (!session) throw new Error("Para pagar con plata de la caja, primero abrí la caja.");
      const supplier = input.supplierId ? await db.suppliers.get(input.supplierId) : undefined;
      await addCashMovement(session.id, "egreso", total, `Pago a ${supplier?.name ?? "proveedor"}`, input.userName);
    }
  });
  return purchase;
}

export const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
