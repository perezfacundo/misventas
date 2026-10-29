import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import type { ExpiringLot } from "@misventas/core";
import type { Lot } from "../db";
import { discardLot, useExpiringLots } from "../data/lots";
import { useProducts } from "../data/products";
import { plural } from "../lib/format";
import { Button, cx, EmptyState, Field, Modal, TextInput, useToast } from "./ui";
import { useSession } from "./Session";

const dmy = (iso: string) => iso.split("-").reverse().join("/");

export function whenText(daysLeft: number): string {
  if (daysLeft < 0) return `venció hace ${plural(-daysLeft, "día", "días")}`;
  if (daysLeft === 0) return "vence hoy";
  if (daysLeft === 1) return "vence mañana";
  return `vence en ${plural(daysLeft, "día", "días")}`;
}

/** Lo que vence pronto en esta sucursal, del más urgente al menos, con opción de dar de baja lo vencido. */
export function ExpiringLots({ days = 7, limit }: { days?: number; limit?: number }) {
  const expiring = useExpiringLots(days);
  const products = useProducts();
  const { can } = useSession();
  const [discarding, setDiscarding] = useState<ExpiringLot<Lot> | null>(null);
  const names = new Map(products.map((p) => [p.id, p.name]));
  const shown = limit ? expiring.slice(0, limit) : expiring;

  if (!expiring.length) {
    return <EmptyState icon={<CalendarClock />} title="Nada por vencer">Ningún lote vence en los próximos {days} días.</EmptyState>;
  }
  return (
    <>
      <ul className="divide-y divide-line">
        {shown.map((e) => (
          <li key={e.lot.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg font-semibold">{names.get(e.lot.productId) ?? "Producto"}</span>
              <span className={cx("font-semibold", e.daysLeft < 0 ? "text-danger" : e.daysLeft <= 2 ? "text-warn" : "text-muted")}>
                {whenText(e.daysLeft)} ({dmy(e.lot.expiresAt)})
              </span>
              <span className="text-muted"> · quedarían {plural(e.remaining, "unidad", "unidades")}</span>
            </span>
            {can("editarProductos") && <Button onClick={() => setDiscarding(e)}>Dar de baja</Button>}
          </li>
        ))}
        {limit && expiring.length > limit && <li className="pt-2.5 text-muted">y {expiring.length - limit} más…</li>}
      </ul>
      <DiscardDialog item={discarding} name={discarding ? names.get(discarding.lot.productId) ?? "" : ""} onClose={() => setDiscarding(null)} />
    </>
  );
}

function DiscardDialog({ item, name, onClose }: { item: ExpiringLot<Lot> | null; name: string; onClose: () => void }) {
  const [units, setUnits] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (item) setUnits(String(item.remaining));
  }, [item]);
  if (!item) return null;
  const n = Math.round(Number(units));
  return (
    <Modal open onClose={onClose} title={`Dar de baja: ${name}`} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="danger" disabled={!(n > 0)} onClick={async () => {
          await discardLot(item.lot, n);
          toast({ tone: "ok", message: `Diste de baja ${plural(n, "unidad", "unidades")} de ${name}` });
          onClose();
        }}>Dar de baja</Button>
      </>
    }>
      <div className="flex flex-col gap-4">
        <p className="text-lg">El lote {whenText(item.daysLeft)}. Contá cuántas unidades de ese lote hay para tirar: salen del stock como rotura o vencido.</p>
        <Field label="Unidades"><TextInput inputMode="numeric" value={units} onChange={(e) => setUnits(e.target.value.replace(/\D/g, ""))} /></Field>
      </div>
    </Modal>
  );
}
