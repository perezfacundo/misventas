import { useLiveQuery } from "dexie-react-hooks";
import { ArrowDownRight, ArrowUpRight, PackageX } from "lucide-react";
import { formatMoney, PAYMENT_LABELS, percentChange, stockStatus, summarizeSales, type PaymentMethod } from "@misventas/core";
import { BarList } from "../components/charts";
import { useProducts } from "../data/products";
import { salesBetween, startOfDay } from "../data/sales";
import { formatLongDay } from "../lib/format";
import { useNow, type Route } from "../lib/hooks";
import { Button, Card, cx, EmptyState, PageHeader, StockBadge } from "../components/ui";
import { useSession } from "../components/Session";

const WEEK = 7 * 24 * 60 * 60 * 1000;

export function Hoy({ navigate }: { navigate: (r: Route) => void }) {
  const now = useNow(60_000);
  const products = useProducts();
  const { can } = useSession();
  const data = useLiveQuery(async () => {
    const from = startOfDay(now);
    const to = Date.now();
    // Comparación justa: el mismo día de la semana pasada, hasta la misma hora.
    const [today, lastWeek] = await Promise.all([salesBetween(from, to + 1), salesBetween(from - WEEK, to - WEEK)]);
    return { today: summarizeSales(today), lastWeek: summarizeSales(lastWeek) };
  }, [now.getTime()]);

  const missing = products.filter((p) => p.trackStock && stockStatus(p.stock, p.minStock) !== "ok");

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title="Hoy" subtitle={formatLongDay(now)} />

      <div className={cx("grid gap-4", can("verCostos") ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <StatTile label="Vendido" value={data ? formatMoney(data.today.total) : "…"} change={data && percentChange(data.today.total, data.lastWeek.total)} emphasis />
        {can("verCostos") && <StatTile label="Ganancia estimada" value={data ? formatMoney(data.today.profit) : "…"} change={data && percentChange(data.today.profit, data.lastWeek.profit)} hint="Solo productos con costo cargado" />}
        <StatTile label="Ventas" value={data ? String(data.today.count) : "…"} change={data && percentChange(data.today.count, data.lastWeek.count)} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-xl font-bold">Cómo te pagaron</h2>
          {data && data.today.count > 0 ? (
            <BarList rows={(Object.entries(data.today.byMethod) as [PaymentMethod, number][]).sort((a, b) => b[1] - a[1]).map(([m, v]) => ({ label: PAYMENT_LABELS[m], value: v }))} />
          ) : (
            <p className="text-lg text-muted">Todavía no hay ventas hoy.</p>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-bold">Me faltan</h2>
            {missing.length > 0 && <Button onClick={() => navigate("productos")}>Ver todos</Button>}
          </div>
          {missing.length === 0 ? (
            <EmptyState icon={<PackageX />} title="No falta nada">Ningún producto está por debajo del mínimo.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {missing.slice(0, 8).map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-4 py-2.5">
                  <span className="text-lg">{p.name}</span>
                  <StockBadge stock={p.stock} minStock={p.minStock} trackStock={p.trackStock} />
                </li>
              ))}
              {missing.length > 8 && <li className="pt-2.5 text-muted">y {missing.length - 8} más…</li>}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatTile({ label, value, change, hint, emphasis = false }: {
  label: string;
  value: string;
  change: number | null | undefined;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <Card className={cx(emphasis && "border-brand/40 bg-brand-soft!")}>
      <p className="text-lg font-semibold text-muted">{label}</p>
      <p className="num mt-1 text-4xl font-extrabold lg:text-5xl">{value}</p>
      {change !== null && change !== undefined ? (
        <p className="mt-2 flex items-center gap-1 text-base text-muted">
          {change >= 0 ? <ArrowUpRight className="size-5 text-brand" /> : <ArrowDownRight className="size-5 text-danger" />}
          <span className="font-semibold text-ink">{change >= 0 ? "+" : "−"}{Math.abs(Math.round(change))}%</span>
          que el mismo día la semana pasada
        </p>
      ) : (
        <p className="mt-2 text-base text-muted">{hint ?? "Sin datos de la semana pasada para comparar"}</p>
      )}
      {hint && change !== null && change !== undefined && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </Card>
  );
}
