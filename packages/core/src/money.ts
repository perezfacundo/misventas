/** Todo el dinero se maneja en centavos enteros para evitar errores de redondeo. */
export type Cents = number;

const withDecimals = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const withoutDecimals = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** "$ 2.400" o "$ 2.400,50": los decimales solo aparecen si hay centavos. */
export function formatMoney(cents: Cents): string {
  const value = cents / 100;
  const fmt = cents % 100 === 0 ? withoutDecimals : withDecimals;
  return fmt.format(value).replace(/ /g, " ");
}

/**
 * Interpreta lo que tipea una persona: "1500", "1.500", "1.500,50", "1500,5", "1500.5".
 * Con coma, la coma es decimal y los puntos son de miles (formato es-AR).
 * Sin coma, un punto seguido de exactamente 3 dígitos se toma como separador de miles.
 */
export function parseMoney(input: string): Cents | null {
  let s = input.trim().replace(/[$\s]/g, "");
  if (s === "") return null;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export type RoundingMode = "up" | "nearest";

/** Redondea a un múltiplo de `step` (en centavos). step <= 0 no redondea. */
export function roundPrice(cents: Cents, step: Cents, mode: RoundingMode = "up"): Cents {
  if (step <= 0) return Math.round(cents);
  const units = cents / step;
  return (mode === "up" ? Math.ceil(units - 1e-9) : Math.round(units)) * step;
}

export const pesos = (n: number): Cents => Math.round(n * 100);
