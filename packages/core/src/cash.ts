import type { Cents } from "./money.ts";
import type { SaleLike } from "./reports.ts";

export type CashMovementType = "ingreso" | "egreso";

export interface CashMovementLike {
  type: CashMovementType;
  amount: Cents;
}

/** Efectivo que debería haber en el cajón: apertura + ventas en efectivo + ingresos − egresos. */
export function expectedCash(
  opening: Cents,
  sales: readonly SaleLike[],
  movements: readonly CashMovementLike[],
): Cents {
  const cashSales = sales
    .filter((s) => s.status === "completada")
    .flatMap((s) => s.payments)
    .filter((p) => p.method === "efectivo")
    .reduce((sum, p) => sum + p.amount, 0);
  const net = movements.reduce((sum, m) => sum + (m.type === "ingreso" ? m.amount : -m.amount), 0);
  return opening + cashSales + net;
}

/** Positivo: sobra plata. Negativo: falta. */
export const cashDifference = (counted: Cents, expected: Cents): Cents => counted - expected;
