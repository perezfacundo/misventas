/**
 * El stock nunca se sobrescribe: se registran movimientos con signo y el stock es su suma.
 * Así dos cajas que venden offline el mismo producto no se pisan al sincronizar.
 */
export type StockMovementType =
  | "inicial"
  | "compra"
  | "venta"
  | "anulacion"
  | "ajuste"
  | "merma"
  | "devolucion"
  | "transferencia_salida"
  | "transferencia_entrada";

export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  inicial: "Stock inicial",
  compra: "Ingreso de mercadería",
  venta: "Venta",
  anulacion: "Venta anulada",
  ajuste: "Ajuste por conteo",
  merma: "Rotura o vencido",
  devolucion: "Devolución de cliente",
  transferencia_salida: "Envío a otra sucursal",
  transferencia_entrada: "Recibido de otra sucursal",
};

/** Sucursal por defecto: id fijo, así todos los dispositivos de un comercio la comparten sin duplicarla. */
export const DEFAULT_BRANCH_ID = "principal";

export interface StockMovementLike {
  productId: string;
  /** Positivo entra, negativo sale. */
  delta: number;
  /** Sucursal del movimiento (sin dato: la principal). */
  branchId?: string;
}

const OUTGOING: ReadonlySet<StockMovementType> = new Set(["venta", "merma", "transferencia_salida"]);

/** Convierte una cantidad (siempre positiva) en el delta con signo según el tipo de movimiento. */
export function movementDelta(type: StockMovementType, quantity: number): number {
  const q = Math.abs(quantity);
  return OUTGOING.has(type) ? -q : q;
}

/** Para un ajuste por conteo: cuánto hay que mover para que el stock quede en lo contado. */
export const adjustmentDelta = (current: number, counted: number): number => counted - current;

export function stockFromMovements(movements: readonly StockMovementLike[], productId: string, branchId?: string): number {
  return movements.reduce(
    (sum, m) => (m.productId === productId && (branchId === undefined || (m.branchId ?? DEFAULT_BRANCH_ID) === branchId) ? sum + m.delta : sum),
    0,
  );
}

/** Stock de un producto en cada sucursal. */
export function stockByBranch(movements: readonly StockMovementLike[], productId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of movements) {
    if (m.productId !== productId) continue;
    const b = m.branchId ?? DEFAULT_BRANCH_ID;
    out.set(b, (out.get(b) ?? 0) + m.delta);
  }
  return out;
}

export type StockStatus = "ok" | "bajo" | "agotado";

export function stockStatus(stock: number, minStock: number): StockStatus {
  if (stock <= 0) return "agotado";
  if (stock <= minStock) return "bajo";
  return "ok";
}
