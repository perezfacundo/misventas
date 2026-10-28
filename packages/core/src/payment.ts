import type { Cents } from "./money.ts";

export type PaymentMethod = "efectivo" | "debito" | "credito" | "transferencia" | "mercadopago" | "fiado";

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  efectivo: "Efectivo",
  debito: "Débito",
  credito: "Crédito",
  transferencia: "Transferencia",
  mercadopago: "Mercado Pago",
  fiado: "Fiado",
};

export interface Payment {
  method: PaymentMethod;
  /** Monto que se imputa a la venta (en efectivo, ya descontado el vuelto). */
  amount: Cents;
  /** Solo efectivo: lo que entregó el cliente. */
  tendered?: Cents;
  /** Número de operación o comprobante del posnet/transferencia. */
  reference?: string;
  /** Cobro integrado con Mercado Pago (si no, el pago se registró a mano). */
  provider?: PaymentProvider;
  /** Id del cobro en el servidor, para rastrearlo. */
  chargeId?: string;
}

export type PaymentProvider = "mp_qr" | "mp_point";

export interface TenderInput {
  method: PaymentMethod;
  amount: Cents;
  reference?: string;
  provider?: PaymentProvider;
  chargeId?: string;
}

export type SettleResult =
  | { ok: true; payments: Payment[]; change: Cents }
  | { ok: false; reason: "falta"; remaining: Cents }
  | { ok: false; reason: "excede-sin-efectivo"; excess: Cents };

/**
 * Valida lo que entrega el cliente y calcula el vuelto.
 * El vuelto solo puede salir del efectivo: si los medios electrónicos superan el total, es un error.
 */
export function settle(total: Cents, tenders: readonly TenderInput[]): SettleResult {
  const valid = tenders.filter((t) => t.amount > 0);
  const nonCash = valid.filter((t) => t.method !== "efectivo").reduce((s, t) => s + t.amount, 0);
  const cash = valid.filter((t) => t.method === "efectivo").reduce((s, t) => s + t.amount, 0);

  if (nonCash > total) return { ok: false, reason: "excede-sin-efectivo", excess: nonCash - total };
  const remaining = total - nonCash - cash;
  if (remaining > 0) return { ok: false, reason: "falta", remaining };

  const change = remaining < 0 ? -remaining : 0;
  const payments: Payment[] = valid
    .filter((t) => t.method !== "efectivo")
    .map((t) => ({
      method: t.method,
      amount: t.amount,
      reference: t.reference || undefined,
      ...(t.provider ? { provider: t.provider, chargeId: t.chargeId } : {}),
    }));
  if (cash > 0) {
    payments.unshift({ method: "efectivo", amount: cash - change, tendered: cash });
  }
  return { ok: true, payments, change };
}

/** Lo que falta cobrar (nunca negativo). */
export function remainingToPay(total: Cents, tenders: readonly TenderInput[]): Cents {
  return Math.max(0, total - tenders.reduce((s, t) => s + Math.max(0, t.amount), 0));
}

const BILLS: Cents[] = [1_000, 2_000, 10_000, 20_000].map((p) => p * 100);

/** Montos sugeridos para cobrar en efectivo: el justo y los billetes "redondos" que lo superan. */
export function suggestCashAmounts(total: Cents, max = 4): Cents[] {
  if (total <= 0) return [];
  const rounded = BILLS.map((b) => Math.ceil(total / b) * b).filter((v) => v > total);
  return [total, ...[...new Set(rounded)].sort((a, b) => a - b)].slice(0, max);
}
