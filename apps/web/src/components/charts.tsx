import { useState } from "react";
import { formatMoney, type Cents } from "@misventas/core";
import { cx } from "./ui";

/** Barras horizontales de un solo color: la etiqueta y el monto están escritos, el largo solo ayuda a comparar. */
export function BarList({ rows }: { rows: { label: string; value: Cents; detail?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const sum = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <ul className="flex flex-col gap-4">
      {rows.map((r) => {
        const pct = Math.round((r.value / sum) * 100);
        return (
          <li key={r.label} title={`${r.label}: ${formatMoney(r.value)} (${pct}%)`}>
            <div className="mb-1.5 flex items-baseline justify-between gap-4">
              <span className="truncate text-lg font-semibold">{r.label}</span>
              <span className="num whitespace-nowrap text-lg">
                <b>{formatMoney(r.value)}</b> <span className="text-muted">· {r.detail ?? `${pct}%`}</span>
              </span>
            </div>
            <div className="h-3 rounded-full bg-surface-2">
              <div className="h-3 rounded-full bg-brand" style={{ width: `${(r.value / max) * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const dayLabel = new Intl.DateTimeFormat("es-AR", { weekday: "short", day: "numeric", month: "short" });

/**
 * Ventas por día: barras verticales de una serie (el título la nombra, no lleva leyenda).
 * Cada barra tiene tooltip al pasar el mouse o con el teclado, y hay vista de tabla.
 */
export function DayBars({ days }: { days: { day: number; total: Cents; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(...days.map((d) => d.total), 1);
  const labelEvery = days.length > 16 ? Math.ceil(days.length / 8) : 1;

  if (asTable) {
    return (
      <div>
        <table className="num w-full text-left">
          <thead className="text-sm text-muted"><tr><th className="py-1.5 font-semibold">Día</th><th className="py-1.5 text-right font-semibold">Ventas</th><th className="py-1.5 text-right font-semibold">Total</th></tr></thead>
          <tbody className="divide-y divide-line">
            {days.map((d) => (
              <tr key={d.day}><td className="py-1.5">{dayLabel.format(d.day)}</td><td className="py-1.5 text-right">{d.count}</td><td className="py-1.5 text-right font-semibold">{formatMoney(d.total)}</td></tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={() => setAsTable(false)} className="mt-3 font-semibold text-muted underline underline-offset-4">Ver como gráfico</button>
      </div>
    );
  }

  return (
    <div>
      <div className="relative flex h-56 items-end gap-0.5 border-b border-line" onMouseLeave={() => setHover(null)}>
        {/* Guías recesivas a la mitad y al máximo */}
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line" />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
        <span className="num pointer-events-none absolute -top-5 left-0 text-xs text-muted">{formatMoney(max)}</span>
        {days.map((d, i) => (
          <button
            key={d.day}
            type="button"
            aria-label={`${dayLabel.format(d.day)}: ${formatMoney(d.total)}, ${d.count} ventas`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            className="group relative flex h-full flex-1 items-end justify-center focus:outline-none"
          >
            <span
              className={cx("w-full max-w-10 rounded-t-[4px] transition-colors", hover === i ? "bg-brand-hover" : "bg-brand", d.total === 0 && "bg-transparent")}
              style={{ height: `${(d.total / max) * 100}%` }}
            />
            {hover === i && (
              <span className="num pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-xl bg-ink px-3 py-2 text-left text-sm text-bg shadow-lg">
                <span className="block font-semibold capitalize">{dayLabel.format(d.day)}</span>
                <span className="block text-base font-bold">{formatMoney(d.total)}</span>
                <span className="block opacity-80">{d.count} ventas</span>
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex gap-0.5">
        {days.map((d, i) => (
          <span key={d.day} className="num flex-1 text-center text-xs text-muted">{i % labelEvery === 0 ? new Date(d.day).getDate() : ""}</span>
        ))}
      </div>
      <button type="button" onClick={() => setAsTable(true)} className="mt-3 font-semibold text-muted underline underline-offset-4">Ver como tabla</button>
    </div>
  );
}
