import { useLiveQuery } from "dexie-react-hooks";
import { DEFAULT_BRANCH_ID, stockByBranch, uuidv7 } from "@misventas/core";
import { currentBranchId, db, setCurrentBranchId, type Branch, type Transfer, type TransferItem } from "../db";
import { recomputeAllStock, recordMovement } from "./products";
import { saveSettings } from "./settings";

const EMPTY: Branch[] = [];

/** Sucursales del comercio. Si no hay ninguna cargada, el comercio tiene solo la principal. */
export function useBranches(): Branch[] {
  return useLiveQuery(
    () => db.branches.filter((b) => b.active).toArray().then((bs) => bs.sort((a, b) => (a.id === DEFAULT_BRANCH_ID ? -1 : b.id === DEFAULT_BRANCH_ID ? 1 : a.name.localeCompare(b.name, "es")))),
    [],
    EMPTY,
  );
}

/** ¿Hay más de una sucursal? Si no, todo lo de sucursales queda oculto. */
export const hasMultipleBranches = (branches: Branch[]) => branches.length > 1;

export const branchName = (branches: Branch[], id: string | undefined) =>
  branches.find((b) => b.id === (id ?? DEFAULT_BRANCH_ID))?.name ?? (id && id !== DEFAULT_BRANCH_ID ? "Otra sucursal" : "Principal");

export async function createBranch(name: string, address = ""): Promise<Branch> {
  const now = Date.now();
  // La principal se crea con id fijo: todas las cajas la comparten sin duplicarla.
  if (!(await db.branches.get(DEFAULT_BRANCH_ID))) {
    await db.branches.add({ id: DEFAULT_BRANCH_ID, name: "Principal", address: "", active: true, createdAt: now, updatedAt: now });
  }
  const branch: Branch = { id: uuidv7(), name: name.trim(), address: address.trim(), active: true, createdAt: now, updatedAt: now };
  await db.branches.add(branch);
  return branch;
}

export async function renameBranch(id: string, name: string, address: string): Promise<void> {
  await db.branches.update(id, { name: name.trim(), address: address.trim(), updatedAt: Date.now() });
}

/** Cambia la sucursal de esta caja y recalcula el stock que ve. */
export async function setDeviceBranch(id: string): Promise<void> {
  await saveSettings({ branchId: id });
  setCurrentBranchId(id);
  await recomputeAllStock();
}

/** Stock de un producto en cada sucursal (para ver cuánto hay en las otras). */
export function useStockByBranch(productId: string | undefined): Map<string, number> {
  return useLiveQuery(
    async () => (productId ? stockByBranch(await db.stockMovements.where("productId").equals(productId).toArray(), productId) : new Map<string, number>()),
    [productId],
    new Map<string, number>(),
  );
}

// --- Transferencias ---

export function useIncomingTransfers(): Transfer[] {
  return useLiveQuery(
    () => db.transfers.where("status").equals("enviada").filter((t) => t.toBranchId === currentBranchId()).sortBy("createdAt"),
    [],
    [] as Transfer[],
  );
}

export function useOutgoingTransfers(): Transfer[] {
  return useLiveQuery(
    () => db.transfers.where("status").equals("enviada").filter((t) => t.fromBranchId === currentBranchId()).sortBy("createdAt"),
    [],
    [] as Transfer[],
  );
}

/** Envía mercadería a otra sucursal: sale del stock de esta en el momento. */
export async function sendTransfer(input: { toBranchId: string; items: TransferItem[]; userName: string; note?: string }): Promise<Transfer> {
  const transfer: Transfer = {
    id: uuidv7(),
    fromBranchId: currentBranchId(),
    toBranchId: input.toBranchId,
    items: input.items.filter((i) => i.quantity > 0),
    status: "enviada",
    note: input.note,
    createdAt: Date.now(),
    sentBy: input.userName,
  };
  if (transfer.fromBranchId === transfer.toBranchId) throw new Error("Elegí otra sucursal de destino.");
  await db.transaction("rw", [db.transfers, db.products, db.stockMovements], async () => {
    await db.transfers.add(transfer);
    for (const item of transfer.items) await recordMovement(item.productId, "transferencia_salida", item.quantity, { refId: transfer.id });
  });
  return transfer;
}

/** Recibe un envío en esta sucursal: entra lo que efectivamente llegó. */
export async function receiveTransfer(transfer: Transfer, received: Record<string, number>, userName: string): Promise<void> {
  await db.transaction("rw", [db.transfers, db.products, db.stockMovements], async () => {
    const fresh = await db.transfers.get(transfer.id);
    if (!fresh || fresh.status !== "enviada") throw new Error("Este envío ya se recibió o se canceló.");
    if (fresh.toBranchId !== currentBranchId()) throw new Error("Este envío es para otra sucursal.");
    const items = fresh.items.map((i) => ({ ...i, received: Math.max(0, Math.round(received[i.productId] ?? i.quantity)) }));
    for (const item of items) if (item.received) await recordMovement(item.productId, "transferencia_entrada", item.received, { refId: fresh.id });
    await db.transfers.update(fresh.id, { status: "recibida", items, receivedAt: Date.now(), receivedBy: userName });
  });
}

/** Cancela un envío que todavía no se recibió: la mercadería vuelve al stock de esta sucursal. */
export async function cancelTransfer(transfer: Transfer): Promise<void> {
  await db.transaction("rw", [db.transfers, db.products, db.stockMovements], async () => {
    const fresh = await db.transfers.get(transfer.id);
    if (!fresh || fresh.status !== "enviada") throw new Error("Este envío ya se recibió o se canceló.");
    if (fresh.fromBranchId !== currentBranchId()) throw new Error("Solo lo puede cancelar la sucursal que lo envió.");
    for (const item of fresh.items) await recordMovement(item.productId, "transferencia_entrada", item.quantity, { refId: fresh.id, note: "Envío cancelado" });
    await db.transfers.update(fresh.id, { status: "cancelada" });
  });
}
