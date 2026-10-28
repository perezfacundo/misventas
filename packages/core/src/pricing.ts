import { roundPrice, type Cents, type RoundingMode } from "./money.ts";

/** Aumento (o baja, con porcentaje negativo) aplicado a un precio, con redondeo configurable. */
export function applyPercent(
  price: Cents,
  percent: number,
  roundingStep: Cents = 0,
  mode: RoundingMode = "up",
): Cents {
  return roundPrice(price * (1 + percent / 100), roundingStep, mode);
}

/** Margen sobre el costo: (precio − costo) / costo. null si no hay costo. */
export function markupPercent(cost: Cents | null, price: Cents): number | null {
  if (cost === null || cost <= 0) return null;
  return ((price - cost) / cost) * 100;
}

export function priceFromMarkup(cost: Cents, markup: number, roundingStep: Cents = 0): Cents {
  return applyPercent(cost, markup, roundingStep);
}
