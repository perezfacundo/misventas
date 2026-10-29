/**
 * Vencimientos por lote. No se registra de qué lote sale cada unidad vendida (sería lento en el mostrador):
 * se asume que se vende primero lo que vence antes (FEFO), así que el stock actual corresponde a los lotes
 * que vencen más tarde. Con eso alcanza para avisar qué está por vencer y cuántas unidades quedarían.
 */
export interface LotLike {
  id: string;
  productId: string;
  /** AAAA-MM-DD */
  expiresAt: string;
  /** Unidades que entraron con este lote. */
  quantity: number;
  /** Unidades de este lote ya dadas de baja por vencidas o rotas. */
  discarded: number;
}

/** Unidades que probablemente queden de cada lote de un producto, dado su stock actual. */
export function lotRemaining<T extends LotLike>(lots: readonly T[], stock: number): Map<string, number> {
  const result = new Map<string, number>();
  let left = Math.max(0, stock);
  const newestFirst = [...lots].sort((a, b) => b.expiresAt.localeCompare(a.expiresAt));
  for (const lot of newestFirst) {
    const take = Math.min(left, Math.max(0, lot.quantity - lot.discarded));
    result.set(lot.id, take);
    left -= take;
  }
  return result;
}

export interface ExpiringLot<T extends LotLike = LotLike> {
  lot: T;
  remaining: number;
  /** Días hasta el vencimiento (negativo si ya venció). */
  daysLeft: number;
}

const DAY = 86_400_000;
const dayNumber = (iso: string) => Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY);

export function daysUntil(expiresAt: string, today: string): number {
  return dayNumber(expiresAt) - dayNumber(today);
}

/**
 * Lotes con unidades que vencen dentro de `days` días (o ya vencidos), del más urgente al menos.
 * `stockOf` da el stock actual de cada producto.
 */
export function expiringLots<T extends LotLike>(lots: readonly T[], stockOf: (productId: string) => number, today: string, days: number): ExpiringLot<T>[] {
  const byProduct = new Map<string, T[]>();
  for (const l of lots) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  const out: ExpiringLot<T>[] = [];
  for (const [productId, productLots] of byProduct) {
    const remaining = lotRemaining(productLots, stockOf(productId));
    for (const lot of productLots) {
      const left = remaining.get(lot.id) ?? 0;
      const daysLeft = daysUntil(lot.expiresAt, today);
      if (left > 0 && daysLeft <= days) out.push({ lot, remaining: left, daysLeft });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.lot.productId.localeCompare(b.lot.productId));
}
