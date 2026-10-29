import type { Cents } from "./money.ts";
import type { CartLine } from "./cart.ts";

/**
 * Promociones automáticas del kiosco. Se calculan sobre el carrito en cada cambio:
 * - "nxm": lleve N, pague M (2×1, 3×2) entre los productos elegidos; se bonifican los más baratos de cada grupo.
 * - "combo": un conjunto de productos a precio fijo (por ejemplo, gaseosa + alfajor).
 * - "porcentaje": descuento por producto o por categoría.
 * Cada unidad entra en una sola promoción: primero combos, después N×M, al final porcentajes.
 */
export type PromotionKind = "nxm" | "combo" | "porcentaje";

export interface PromotionSchedule {
  /** AAAA-MM-DD, inclusive. */
  from?: string;
  to?: string;
  /** 0 = domingo … 6 = sábado. Vacío o ausente = todos los días. */
  weekdays?: number[];
  /** "HH:MM". Si fromTime > toTime, cruza la medianoche (por ejemplo, 22:00 a 02:00). */
  fromTime?: string;
  toTime?: string;
}

export interface Promotion {
  id: string;
  name: string;
  kind: PromotionKind;
  active: boolean;
  /** nxm y porcentaje: productos incluidos. */
  productIds: string[];
  /** porcentaje: también se puede aplicar a categorías enteras. */
  categories?: string[];
  /** nxm: lleva `buy`, paga `pay`. */
  buy?: number;
  pay?: number;
  /** combo */
  comboItems?: { productId: string; quantity: number }[];
  comboPrice?: Cents;
  /** porcentaje (1 a 100) */
  percent?: number;
  schedule?: PromotionSchedule;
}

export interface AppliedPromotion {
  promotionId: string;
  name: string;
  /** Lo que se descuenta, en centavos (positivo). */
  amount: Cents;
  /** Cuántas veces se aplicó (combos y N×M). */
  times: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** ¿La promoción vale en este momento (hora local)? */
export function isPromotionActive(p: Promotion, now: Date): boolean {
  if (!p.active) return false;
  const s = p.schedule;
  if (!s) return true;
  const today = isoDate(now);
  if (s.from && today < s.from) return false;
  if (s.to && today > s.to) return false;
  if (s.weekdays?.length && !s.weekdays.includes(now.getDay())) return false;
  if (s.fromTime && s.toTime) {
    const t = hhmm(now);
    const inside = s.fromTime <= s.toTime ? t >= s.fromTime && t < s.toTime : t >= s.fromTime || t < s.toTime;
    if (!inside) return false;
  }
  return true;
}

interface Unit {
  productId: string;
  price: Cents;
  used: boolean;
}

/** Calcula qué promociones se aplican al carrito y cuánto descuenta cada una. */
export function applyPromotions(
  lines: readonly CartLine[],
  promotions: readonly Promotion[],
  now: Date,
  categoryOf: (productId: string) => string | undefined = () => undefined,
): AppliedPromotion[] {
  const active = promotions.filter((p) => isPromotionActive(p, now));
  if (!active.length) return [];
  // Cada unidad por separado; las más caras primero para que el N×M bonifique las más baratas de cada grupo.
  const units: Unit[] = lines
    .filter((l) => l.productId && l.quantity > 0)
    .flatMap((l) => Array.from({ length: Math.min(l.quantity, 1000) }, () => ({ productId: l.productId!, price: l.unitPrice, used: false })))
    .sort((a, b) => b.price - a.price);
  const free = (productId: string) => units.filter((u) => !u.used && u.productId === productId);
  const applied: AppliedPromotion[] = [];

  for (const p of active.filter((x) => x.kind === "combo" && x.comboItems?.length && x.comboPrice !== undefined)) {
    let times = 0;
    let amount = 0;
    for (;;) {
      const picked: Unit[] = [];
      let complete = true;
      for (const item of p.comboItems!) {
        const available = free(item.productId).filter((u) => !picked.includes(u));
        if (available.length < item.quantity) {
          complete = false;
          break;
        }
        // Para el combo se toman las unidades más baratas disponibles de cada producto.
        picked.push(...available.slice(-item.quantity));
      }
      if (!complete) break;
      const regular = picked.reduce((s, u) => s + u.price, 0);
      const saving = regular - p.comboPrice!;
      if (saving <= 0) break; // el combo no le conviene al cliente
      for (const u of picked) u.used = true;
      times++;
      amount += saving;
    }
    if (amount > 0) applied.push({ promotionId: p.id, name: p.name, amount, times });
  }

  for (const p of active.filter((x) => x.kind === "nxm" && (x.buy ?? 0) > (x.pay ?? 0) && (x.pay ?? 0) >= 0)) {
    const ids = new Set(p.productIds);
    const eligible = units.filter((u) => !u.used && ids.has(u.productId));
    const groupSize = p.buy!;
    const freePerGroup = p.buy! - p.pay!;
    let times = 0;
    let amount = 0;
    for (let i = 0; i + groupSize <= eligible.length; i += groupSize) {
      const group = eligible.slice(i, i + groupSize);
      for (const u of group) u.used = true;
      amount += group.slice(-freePerGroup).reduce((s, u) => s + u.price, 0);
      times++;
    }
    if (amount > 0) applied.push({ promotionId: p.id, name: p.name, amount, times });
  }

  for (const p of active.filter((x) => x.kind === "porcentaje" && (x.percent ?? 0) > 0)) {
    const ids = new Set(p.productIds);
    const cats = new Set(p.categories ?? []);
    const eligible = units.filter((u) => !u.used && (ids.has(u.productId) || cats.has(categoryOf(u.productId) ?? "\u0000")));
    const base = eligible.reduce((s, u) => s + u.price, 0);
    const amount = Math.round((base * Math.min(p.percent!, 100)) / 100);
    for (const u of eligible) u.used = true;
    if (amount > 0) applied.push({ promotionId: p.id, name: p.name, amount, times: eligible.length });
  }

  return applied;
}

export const promotionsTotal = (applied: readonly AppliedPromotion[]): Cents => applied.reduce((s, a) => s + a.amount, 0);

/** Descripción corta para listas: "2×1", "Combo $ 2.000", "10% off". */
export function describePromotion(p: Promotion, formatMoney: (c: Cents) => string): string {
  if (p.kind === "nxm") return `${p.buy}×${p.pay}`;
  if (p.kind === "combo") return `Combo ${formatMoney(p.comboPrice ?? 0)}`;
  return `${p.percent}% de descuento`;
}
