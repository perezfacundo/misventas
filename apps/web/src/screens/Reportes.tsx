import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Download } from "lucide-react";
import {
  debtors, formatMoney, PAYMENT_LABELS, productsWithoutSales, salesByDay, salesByGroup, salesByProduct, salesByUser,
  summarizeSales, type PaymentMethod, type ReportSale,
} from "@misventas/core";
import { useProducts } from "../data/products";
import { useAccountMovements } from "../data/customers";
import { salesBetween, startOfDay } from "../data/sales";
import { downloadFile } from "../data/csv";
import { formatDate, formatDateTime, plural } from "../lib/format";
import { Button, Card, PageHeader, Segmented } from "../components/ui";
import { BarList, DayBars } from "../components/charts";
import { useSession } from "../components/Session";
import { hasMultipleBranches, useBranches } from "../data/branches";
import { DEFAULT_BRANCH_ID } from "@misventas/core";

type Period = "hoy" | "7d" | "30d" | "mes" | "mesPasado";

function rangeOf(period: Period): { from: number; to: number; label: string } {
  const today = startOfDay();
  const now = new Date();
  const tomorrow = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  switch (period) {
    case "hoy":
      return { from: today, to: tomorrow, label: "hoy" };
    case "7d":
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: tomorrow, label: "los últimos 7 días" };
    case "30d":
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to: tomorrow, label: "los últimos 30 días" };
    case "mes":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: tomorrow, label: "este mes" };
    case "mesPasado":
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
        to: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
        label: "el mes pasado",
      };
  }
}

export function Reportes() {
  const [period, setPeriod] = useState<Period>("7d");
  const { can } = useSession();
  const range = rangeOf(period);
  const products = useProducts();
  const movements = useAccountMovements();
  const branches = useBranches();
  const [branch, setBranch] = useState<string>("todas");
  const all = useLiveQuery(() => salesBetween(range.from, range.to), [range.from, range.to], []);
  const sales = useMemo(() => (branch === "todas" ? all : all.filter((s) => (s.branchId ?? DEFAULT_BRANCH_ID) === branch)), [all, branch]);
  const reportSales: ReportSale[] = useMemo(() => sales.map((s) => ({ ...s, userName: s.cashier })), [sales]);

  const summary = summarizeSales(sales);
  const categoryOf = useMemo(() => {
    const map = new Map(products.map((p) => [p.id, p.category || "Sin categoría"]));
    return (id: string | null) => (id ? map.get(id) ?? "Sin categoría" : "Varios");
  }, [products]);
  const top = salesByProduct(sales).slice(0, 15);
  const categories = salesByGroup(sales, categoryOf);
  const cashiers = salesByUser(reportSales);
  const idle = productsWithoutSales(products, sales);
  const owed = debtors(movements).reduce((s, d) => s + d.balance, 0);
  const methods = (Object.entries(summary.byMethod) as [PaymentMethod, number][]).sort((a, b) => b[1] - a[1]);

  const exportCsv = () => {
    const lines = sales.map((s) =>
      [formatDateTime(s.createdAt), s.number, s.cashier, s.status, (s.total / 100).toFixed(2).replace(".", ","), s.payments.map((p) => PAYMENT_LABELS[p.method]).join(" + ")].join(";"),
    );
    downloadFile(`ventas-${formatDate(range.from).replace(/\//g, "-")}.csv`, "﻿" + ["fecha;numero;cajero;estado;total;medios", ...lines].join("\r\n"), "text/csv;charset=utf-8");
  };

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader
        title="Reportes"
        subtitle={`Ventas de ${range.label}, ${branch === "todas" ? "de todas las cajas" : `de ${branches.find((b) => b.id === branch)?.name ?? "la sucursal"}`}`}
        actions={<Button onClick={exportCsv} disabled={!sales.length}><Download className="size-5" /> Exportar ventas</Button>}
      />
      <div className="mb-6">
        <Segmented
          label="Período"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "hoy", label: "Hoy" },
            { value: "7d", label: "7 días" },
            { value: "30d", label: "30 días" },
            { value: "mes", label: "Este mes" },
            { value: "mesPasado", label: "Mes pasado" },
          ]}
        />
        {hasMultipleBranches(branches) && (
          <div className="mt-3">
            <Segmented label="Sucursal" value={branch} onChange={setBranch}
              options={[{ value: "todas", label: "Todas las sucursales" }, ...branches.map((b) => ({ value: b.id, label: b.name }))]} />
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Vendido" value={formatMoney(summary.total)} />
        <Kpi label="Ventas" value={String(summary.count)} />
        <Kpi label="Ticket promedio" value={formatMoney(summary.count ? Math.round(summary.total / summary.count) : 0)} />
        {can("verCostos") ? <Kpi label="Ganancia estimada" value={formatMoney(summary.profit)} /> : <Kpi label="Te deben (fiado)" value={formatMoney(owed)} />}
      </div>

      {period !== "hoy" && (
        <Card className="mt-6">
          <h2 className="mb-6 text-xl font-bold">Ventas por día</h2>
          <DayBars days={salesByDay(reportSales, range.from, range.to)} />
        </Card>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-xl font-bold">Lo más vendido</h2>
          {top.length === 0 ? <p className="text-muted">Sin ventas en el período.</p> : (
            <table className="num w-full text-left">
              <thead className="text-sm text-muted"><tr><th className="py-1.5 font-semibold">Producto</th><th className="py-1.5 text-right font-semibold">Unidades</th><th className="py-1.5 text-right font-semibold">Total</th></tr></thead>
              <tbody className="divide-y divide-line">
                {top.map((r) => (
                  <tr key={r.key}><td className="py-2 pr-2">{r.name}</td><td className="py-2 text-right">{r.units}</td><td className="py-2 text-right font-semibold">{formatMoney(r.total)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card>
          <h2 className="mb-4 text-xl font-bold">Por categoría</h2>
          {categories.length === 0 ? <p className="text-muted">Sin ventas en el período.</p> : (
            <BarList rows={categories.map((c) => ({ label: c.group, value: c.total }))} />
          )}
        </Card>
        <Card>
          <h2 className="mb-4 text-xl font-bold">Cómo te pagaron</h2>
          {methods.length === 0 ? <p className="text-muted">Sin ventas en el período.</p> : (
            <BarList rows={methods.map(([m, v]) => ({ label: PAYMENT_LABELS[m], value: v }))} />
          )}
        </Card>
        <Card>
          <h2 className="mb-4 text-xl font-bold">Por cajero</h2>
          {cashiers.length === 0 ? <p className="text-muted">Sin ventas en el período.</p> : (
            <ul className="num divide-y divide-line">
              {cashiers.map((c) => (
                <li key={c.userName} className="flex justify-between gap-3 py-2 text-lg">
                  <span>{c.userName} <span className="text-muted">· {plural(c.count, "venta", "ventas")}</span></span>
                  <b>{formatMoney(c.total)}</b>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <h2 className="text-xl font-bold">Sin movimiento</h2>
          <p className="mb-3 text-muted">{plural(idle.length, "producto no se vendió", "productos no se vendieron")} en {range.label}.</p>
          {idle.length > 0 && <p>{idle.slice(0, 40).map((p) => p.name).join(", ")}{idle.length > 40 ? "…" : ""}</p>}
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-lg font-semibold text-muted">{label}</p>
      <p className="num mt-1 text-4xl font-extrabold">{value}</p>
    </Card>
  );
}
