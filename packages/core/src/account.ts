import type { Cents } from "./money.ts";

/**
 * Cuenta corriente (fiado): movimientos con signo, igual que el stock.
 * Positivo = el cliente debe más (compra fiada). Negativo = pagó.
 */
export type AccountMovementType = "compra" | "pago" | "anulacion" | "ajuste";

export interface AccountMovementLike {
  customerId: string;
  amount: Cents;
  createdAt: number;
}

export function balanceOf(movements: readonly AccountMovementLike[], customerId: string): Cents {
  return movements.reduce((sum, m) => (m.customerId === customerId ? sum + m.amount : sum), 0);
}

export interface Debtor {
  customerId: string;
  balance: Cents;
  /** Fecha de la deuda más vieja sin cubrir (aproximada: primer movimiento desde el último saldo en cero). */
  since: number;
}

/** Clientes con saldo deudor, de mayor a menor deuda. */
export function debtors(movements: readonly AccountMovementLike[]): Debtor[] {
  const sorted = [...movements].sort((a, b) => a.createdAt - b.createdAt);
  const state = new Map<string, { balance: Cents; since: number }>();
  for (const m of sorted) {
    const s = state.get(m.customerId) ?? { balance: 0, since: m.createdAt };
    if (s.balance <= 0 && m.amount > 0) s.since = m.createdAt;
    s.balance += m.amount;
    state.set(m.customerId, s);
  }
  return [...state.entries()]
    .filter(([, s]) => s.balance > 0)
    .map(([customerId, s]) => ({ customerId, ...s }))
    .sort((a, b) => b.balance - a.balance);
}

export type CreditCheck = { ok: true } | { ok: false; exceededBy: Cents };

/** null = sin límite. */
export function checkCreditLimit(balance: Cents, amount: Cents, limit: Cents | null): CreditCheck {
  if (limit === null) return { ok: true };
  const after = balance + amount;
  return after <= limit ? { ok: true } : { ok: false, exceededBy: after - limit };
}

/**
 * Normaliza un teléfono argentino para wa.me: "011 15-1234-5678" → "5491112345678".
 * Devuelve null si no parece un número válido.
 */
export function whatsappNumber(phone: string): string | null {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("9")) d = d.slice(1);
  if (d.startsWith("0")) d = d.slice(1);
  // Quita el "15" de celular que va después del código de área (2 a 4 dígitos).
  const m = /^(\d{2,4}?)15(\d{6,8})$/.exec(d);
  if (m && m[1]!.length + m[2]!.length === 10) d = m[1]! + m[2]!;
  return d.length === 10 ? `549${d}` : null;
}

export function whatsappLink(phone: string, message: string): string | null {
  const n = whatsappNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(message)}` : null;
}
