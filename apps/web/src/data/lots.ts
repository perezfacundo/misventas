import { useLiveQuery } from "dexie-react-hooks";
import { DEFAULT_BRANCH_ID, expiringLots, uuidv7, type ExpiringLot } from "@misventas/core";
import { currentBranchId, db, type Lot } from "../db";
import { recordMovement } from "./products";

/** Fecha de hoy (hora local) como AAAA-MM-DD. */
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Registra el vencimiento de lo que entró. Debe llamarse dentro de la transacción del ingreso. */
export async function addLot(input: { productId: string; expiresAt: string; quantity: number; purchaseId?: string }): Promise<void> {
  await db.lots.add({ id: uuidv7(), ...input, discarded: 0, branchId: currentBranchId(), createdAt: Date.now() });
}

/** Lotes de esta sucursal que vencen dentro de `days` días (o ya vencieron), con las unidades que quedarían. */
export function useExpiringLots(days = 7): ExpiringLot<Lot>[] {
  return useLiveQuery(
    async () => {
      const branch = currentBranchId();
      const lots = await db.lots.filter((l) => (l.branchId ?? DEFAULT_BRANCH_ID) === branch).toArray();
      if (!lots.length) return [];
      const products = new Map((await db.products.toArray()).map((p) => [p.id, p]));
      const active = lots.filter((l) => products.get(l.productId)?.active && products.get(l.productId)?.tracksExpiry);
      return expiringLots(active, (id) => products.get(id)?.stock ?? 0, todayIso(), days);
    },
    [days],
    [],
  );
}

/** Da de baja las unidades vencidas de un lote: sale del stock como merma y el lote queda descontado. */
export async function discardLot(lot: Lot, units: number): Promise<void> {
  await db.transaction("rw", [db.lots, db.products, db.stockMovements], async () => {
    const fresh = await db.lots.get(lot.id);
    if (!fresh || units <= 0) return;
    await recordMovement(lot.productId, "merma", units, { refId: lot.id, note: `Vencido el ${lot.expiresAt.split("-").reverse().join("/")}` });
    await db.lots.update(lot.id, { discarded: fresh.discarded + units });
  });
}
