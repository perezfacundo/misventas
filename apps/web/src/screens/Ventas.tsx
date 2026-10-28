import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Ban, ChevronLeft, ChevronRight, Printer, Receipt } from "lucide-react";
import { formatMoney, lineTotal, PAYMENT_LABELS, summarizeSales } from "@misventas/core";
import { db, type Sale, type Settings } from "../db";
import { salesBetween, startOfDay, voidSale } from "../data/sales";
import { formatLongDay, formatTime, plural } from "../lib/format";
import { Button, Card, cx, EmptyState, Field, Modal, PageHeader, TextInput, useToast } from "../components/ui";
import { printTicket } from "../components/Ticket";
import { useSession } from "../components/Session";

const DAY = 24 * 60 * 60 * 1000;

export function Ventas({ settings }: { settings: Settings }) {
  const [day, setDay] = useState(() => startOfDay());
  const [openId, setOpenId] = useState<string | null>(null);
  const sales = useLiveQuery(() => salesBetween(day, day + DAY), [day], []);
  const summary = summarizeSales(sales);
  const isToday = day === startOfDay();
  const selected = sales.find((s) => s.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-5xl p-4 lg:p-8">
      <PageHeader
        title="Ventas"
        subtitle={`${plural(summary.count, "venta", "ventas")} · ${formatMoney(summary.total)}`}
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setDay((d) => d - DAY)} aria-label="Día anterior"><ChevronLeft className="size-5" /></Button>
            <span className="min-w-44 text-center text-lg font-semibold">{isToday ? "Hoy" : formatLongDay(day)}</span>
            <Button onClick={() => setDay((d) => d + DAY)} disabled={isToday} aria-label="Día siguiente"><ChevronRight className="size-5" /></Button>
          </div>
        }
      />
      <Card className="p-0">
        {sales.length === 0 ? (
          <EmptyState icon={<Receipt />} title="No hay ventas este día" />
        ) : (
          <ul className="divide-y divide-line">
            {sales.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => setOpenId(s.id)} className="flex w-full items-center gap-4 px-5 py-3.5 text-left hover:bg-surface-2">
                  <span className="num w-16 text-lg text-muted">{formatTime(s.createdAt)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg font-semibold">{s.items.map((i) => (i.quantity > 1 ? `${i.quantity}× ${i.name}` : i.name)).join(", ")}</span>
                    <span className="text-muted">{s.number} · {s.cashier} · {s.payments.map((p) => PAYMENT_LABELS[p.method]).join(" + ")}</span>
                  </span>
                  {s.status === "anulada" && <span className="rounded-lg bg-danger-soft px-2.5 py-1 text-sm font-semibold text-danger">Anulada</span>}
                  <span className={cx("num w-28 text-right text-xl font-bold", s.status === "anulada" && "text-muted line-through")}>{formatMoney(s.total)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <SaleDetail sale={selected} settings={settings} onClose={() => setOpenId(null)} />
    </div>
  );
}

function SaleDetail({ sale, settings, onClose }: { sale: Sale | null; settings: Settings; onClose: () => void }) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const toast = useToast();
  const { user, can } = useSession();
  const canVoid = useLiveQuery(
    async () => (sale && can("anularVenta") ? (await db.cashSessions.get(sale.cashSessionId))?.status === "abierta" && sale.status === "completada" : false),
    [sale?.id, sale?.status, user.id],
    false,
  );
  const customer = useLiveQuery(async () => (sale?.customerId ? db.customers.get(sale.customerId) : undefined), [sale?.customerId]);
  useEffect(() => {
    setVoiding(false);
    setReason("");
  }, [sale?.id]);

  if (!sale) return null;
  const doVoid = async () => {
    try {
      await voidSale(sale.id, reason.trim(), user.name);
      toast({ tone: "ok", message: `Anulaste la venta ${sale.number}. El stock volvió a su lugar.` });
      onClose();
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : "No se pudo anular." });
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Venta ${sale.number}`}
      footer={
        voiding ? (
          <>
            <Button onClick={() => setVoiding(false)}>Volver</Button>
            <Button variant="danger" onClick={doVoid} disabled={!reason.trim()}>Confirmar anulación</Button>
          </>
        ) : (
          <>
            {canVoid && <Button variant="danger" className="mr-auto" onClick={() => setVoiding(true)}><Ban className="size-5" /> Anular</Button>}
            <Button onClick={() => printTicket(sale, settings).catch((e: unknown) => toast({ tone: "error", message: `No se pudo imprimir: ${e instanceof Error ? e.message : String(e)}` }))}>
              <Printer className="size-5" /> Imprimir
            </Button>
            <Button variant="primary" onClick={onClose}>Listo</Button>
          </>
        )
      }
    >
      {voiding ? (
        <div className="flex flex-col gap-4">
          <p className="text-lg">Al anular, la venta deja de sumar en la caja y los productos vuelven al stock. Devolvé el dinero al cliente.</p>
          <Field label="¿Por qué se anula?">
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: el cliente se arrepintió" />
          </Field>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-muted">{formatLongDay(sale.createdAt)}, {formatTime(sale.createdAt)} · Atendió {sale.cashier}</p>
          {customer && <p className="rounded-xl bg-surface-2 px-4 py-2.5">Fiado a <b>{customer.name}</b></p>}
          {sale.status === "anulada" && (
            <p className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger">
              Anulada{sale.voidedBy ? ` por ${sale.voidedBy}` : ""}{sale.voidReason ? `: ${sale.voidReason}` : ""}
            </p>
          )}
          <ul className="divide-y divide-line">
            {sale.items.map((l) => (
              <li key={l.lineId} className="num flex justify-between gap-4 py-2 text-lg">
                <span>{l.quantity} × {l.name}</span>
                <span className="font-semibold">{formatMoney(lineTotal(l))}</span>
              </li>
            ))}
          </ul>
          <div className="num flex flex-col gap-1 border-t border-line pt-3 text-lg">
            {sale.discount > 0 && <p className="flex justify-between"><span>Descuento</span><span>−{formatMoney(sale.discount)}</span></p>}
            <p className="flex justify-between text-2xl font-extrabold"><span>Total</span><span>{formatMoney(sale.total)}</span></p>
            {sale.payments.map((p, i) => (
              <p key={i} className="flex justify-between text-muted">
                <span>{PAYMENT_LABELS[p.method]}{p.reference ? ` (op. ${p.reference})` : ""}</span>
                <span>{formatMoney(p.tendered ?? p.amount)}</span>
              </p>
            ))}
            {sale.change > 0 && <p className="flex justify-between text-muted"><span>Vuelto</span><span>{formatMoney(sale.change)}</span></p>}
          </div>
        </div>
      )}
    </Modal>
  );
}
