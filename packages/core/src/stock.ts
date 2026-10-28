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
  | "devolucion";

export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  inicial: "Stock inicial",
  compra: "Ingreso de mercadería",
  venta: "Venta",
  anulacion: "Venta anulada",
  ajuste: "Ajuste por conteo",
  merma: "Rotura o vencido",
  devolucion: "Devolución de cliente",
};

export interface StockMovementLike {
  productId: string;
  /** Positivo entra, negativo sale. */
  delta: number;
}

const OUTGOING: ReadonlySet<StockMovementType> = new Set(["venta", "merma"]);

/** Convierte una cantidad (siempre positiva) en el delta con signo según el tipo de movimiento. */
export function movementDelta(type: StockMovementType, quantity: number): number {
  const q = Math.abs(quantity);
  return OUTGOING.has(type) ? -q : q;
}

/** Para un ajuste por conteo: cuánto hay que mover para que el stock quede en lo contado. */
export const adjustmentDelta = (current: number, counted: number): number => counted - current;

export function stockFromMovements(movements: readonly StockMovementLike[], productId: string): number {
  return movements.reduce((sum, m) => (m.productId === productId ? sum + m.delta : sum), 0);
}

export type StockStatus = "ok" | "bajo" | "agotado";

export function stockStatus(stock: number, minStock: number): StockStatus {
  if (stock <= 0) return "agotado";
  if (stock <= minStock) return "bajo";
  return "ok";
}
