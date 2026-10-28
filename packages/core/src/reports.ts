import type { Cents } from "./money.ts";
import type { Payment, PaymentMethod } from "./payment.ts";
import type { CartLine } from "./cart.ts";
import { estimatedProfit } from "./cart.ts";

export interface SaleLike {
  total: Cents;
  discount: Cents;
  items: readonly CartLine[];
  payments: readonly Payment[];
  status: "completada" | "anulada";
}

export interface SalesSummary {
  total: Cents;
  count: number;
  profit: Cents;
  byMethod: Partial<Record<PaymentMethod, Cents>>;
}

/** Resumen de ventas completadas (las anuladas no suman). */
export function summarizeSales(sales: readonly SaleLike[]): SalesSummary {
  const summary: SalesSummary = { total: 0, count: 0, profit: 0, byMethod: {} };
  for (const sale of sales) {
    if (sale.status !== "completada") continue;
    summary.total += sale.total;
    summary.count += 1;
    summary.profit += estimatedProfit(sale.items, sale.discount);
    for (const p of sale.payments) {
      summary.byMethod[p.method] = (summary.byMethod[p.method] ?? 0) + p.amount;
    }
  }
  return summary;
}

/** Variación porcentual contra un período anterior. null si no hay base de comparación. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export interface ReportSale extends SaleLike {
  createdAt: number;
  userName: string;
}

export interface ProductRow {
  key: string;
  name: string;
  units: number;
  total: Cents;
}

/** Ventas agrupadas por día calendario (hora local). Incluye los días sin ventas del rango. */
export function salesByDay(sales: readonly ReportSale[], from: number, to: number): { day: number; total: Cents; count: number }[] {
  const days = new Map<number, { total: Cents; count: number }>();
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < to) {
    days.set(cursor.getTime(), { total: 0, count: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const s of sales) {
    if (s.status !== "completada") continue;
    const d = new Date(s.createdAt);
    d.setHours(0, 0, 0, 0);
    const row = days.get(d.getTime());
    if (row) {
      row.total += s.total;
      row.count += 1;
    }
  }
  return [...days.entries()].map(([day, v]) => ({ day, ...v }));
}

/** Lo más vendido por importe. Los ítems "Varios" se agrupan por nombre. */
export function salesByProduct(sales: readonly SaleLike[]): ProductRow[] {
  const rows = new Map<string, ProductRow>();
  for (const s of sales) {
    if (s.status !== "completada") continue;
    for (const l of s.items) {
      const key = l.productId ?? `varios:${l.name}`;
      const row = rows.get(key) ?? { key, name: l.name, units: 0, total: 0 };
      row.units += l.quantity;
      row.total += l.unitPrice * l.quantity;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

/** Agrupa ventas por una clave del producto (por ejemplo la categoría). Sin producto → "Sin categoría". */
export function salesByGroup(
  sales: readonly SaleLike[],
  groupOf: (productId: string | null) => string,
): { group: string; total: Cents; units: number }[] {
  const rows = new Map<string, { group: string; total: Cents; units: number }>();
  for (const s of sales) {
    if (s.status !== "completada") continue;
    for (const l of s.items) {
      const group = groupOf(l.productId);
      const row = rows.get(group) ?? { group, total: 0, units: 0 };
      row.total += l.unitPrice * l.quantity;
      row.units += l.quantity;
      rows.set(group, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

export function salesByUser(sales: readonly ReportSale[]): { userName: string; total: Cents; count: number }[] {
  const rows = new Map<string, { userName: string; total: Cents; count: number }>();
  for (const s of sales) {
    if (s.status !== "completada") continue;
    const row = rows.get(s.userName) ?? { userName: s.userName, total: 0, count: 0 };
    row.total += s.total;
    row.count += 1;
    rows.set(s.userName, row);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

/** Productos del catálogo que no se vendieron en el período. */
export function productsWithoutSales<T extends { id: string }>(products: readonly T[], sales: readonly SaleLike[]): T[] {
  const sold = new Set<string>();
  for (const s of sales) {
    if (s.status !== "completada") continue;
    for (const l of s.items) if (l.productId) sold.add(l.productId);
  }
  return products.filter((p) => !sold.has(p.id));
}
