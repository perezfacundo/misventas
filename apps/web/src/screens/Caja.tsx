import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowDownCircle, ArrowUpCircle, Lock, Wallet } from "lucide-react";
import { cashDifference, expectedCash, formatMoney, PAYMENT_LABELS, summarizeSales, type CashMovementType, type Cents, type PaymentMethod } from "@misventas/core";
import { db, getDeviceId, type CashSession } from "../db";
import { addCashMovement, closeSession, useOpenSession } from "../data/cash";
import { formatDateTime, formatTime } from "../lib/format";
import { Button, Card, cx, EmptyState, Field, MoneyInput, Modal, PageHeader, TextInput, useToast } from "../components/ui";
import { OpenCashDialog } from "../components/OpenCashDialog";
import { useSession } from "../components/Session";

export function Caja() {
  const session = useOpenSession();
  const [opening, setOpening] = useState(false);
  // Solo los cierres de esta caja: cada dispositivo es una caja física distinta.
  const history = useLiveQuery(async () => {
    const deviceId = await getDeviceId();
    const closed = await db.cashSessions.where("status").equals("cerrada").filter((s) => s.deviceId === deviceId).reverse().sortBy("openedAt");
    return closed.slice(0, 10);
  }, [], []);

  return (
    <div className="mx-auto max-w-5xl p-4 lg:p-8">
      <PageHeader title="Caja" subtitle={session ? `Abierta por ${session.openedBy} a las ${formatTime(session.openedAt)}` : "La caja está cerrada"} />
      {session === undefined ? null : session ? (
        <OpenSession session={session} />
      ) : (
        <Card>
          <EmptyState icon={<Wallet />} title="No hay una caja abierta">
            <p>Abrí la caja al empezar el turno con el efectivo que hay en el cajón.</p>
            <Button variant="primary" size="lg" className="mt-4" onClick={() => setOpening(true)}>Abrir caja</Button>
          </EmptyState>
        </Card>
      )}

      {history.length > 0 && (
        <Card className="mt-6">
          <h2 className="mb-3 text-xl font-bold">Cierres anteriores</h2>
          <ul className="divide-y divide-line">
            {history.map((s) => {
              const diff = cashDifference(s.countedAmount ?? 0, s.expectedAmount ?? 0);
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <span>
                    <b>{s.openedBy}</b> <span className="text-muted">· {formatDateTime(s.openedAt)} a {s.closedAt ? formatTime(s.closedAt) : "—"}</span>
                  </span>
                  <span className="num">
                    Contado {formatMoney(s.countedAmount ?? 0)} ·{" "}
                    <DiffLabel diff={diff} />
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <OpenCashDialog open={opening} onClose={() => setOpening(false)} />
    </div>
  );
}

function DiffLabel({ diff }: { diff: Cents }) {
  if (diff === 0) return <b className="text-brand">Justo</b>;
  return diff > 0 ? <b className="text-warn">Sobran {formatMoney(diff)}</b> : <b className="text-danger">Faltan {formatMoney(-diff)}</b>;
}

function OpenSession({ session }: { session: CashSession }) {
  const { user, can } = useSession();
  const canClose = session.openedById === user.id || can("cerrarCajaAjena");
  const [movement, setMovement] = useState<CashMovementType | null>(null);
  const [closing, setClosing] = useState(false);
  const data = useLiveQuery(async () => {
    const [sales, movements] = await Promise.all([
      db.sales.where("cashSessionId").equals(session.id).toArray(),
      db.cashMovements.where("cashSessionId").equals(session.id).sortBy("createdAt"),
    ]);
    return { summary: summarizeSales(sales), movements, expected: expectedCash(session.openingAmount, sales, movements) };
  }, [session.id]);
  if (!data) return null;
  const { summary, movements, expected } = data;
  const income = movements.filter((m) => m.type === "ingreso").reduce((s, m) => s + m.amount, 0);
  const expense = movements.filter((m) => m.type === "egreso").reduce((s, m) => s + m.amount, 0);
  const others = (Object.entries(summary.byMethod) as [PaymentMethod, number][]).filter(([m]) => m !== "efectivo");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <Card>
        <p className="text-lg font-semibold text-muted">Efectivo que tiene que haber en el cajón</p>
        <p className="num mt-1 text-6xl font-extrabold">{formatMoney(expected)}</p>
        <dl className="num mt-6 grid gap-x-6 gap-y-2 text-lg sm:grid-cols-2">
          <Row label="Al abrir" value={formatMoney(session.openingAmount)} />
          <Row label="Ventas en efectivo" value={`+ ${formatMoney(summary.byMethod.efectivo ?? 0)}`} />
          <Row label="Ingresos" value={`+ ${formatMoney(income)}`} />
          <Row label="Retiros y pagos" value={`− ${formatMoney(expense)}`} />
        </dl>
        {others.length > 0 && (
          <>
            <p className="mt-6 text-sm font-semibold text-muted">Otros medios (no están en el cajón)</p>
            <dl className="num mt-2 grid gap-x-6 gap-y-2 text-lg sm:grid-cols-2">
              {others.map(([m, v]) => <Row key={m} label={PAYMENT_LABELS[m]} value={formatMoney(v)} />)}
            </dl>
          </>
        )}
        <p className="mt-6 text-lg">
          <b>{summary.count}</b> ventas por <b className="num">{formatMoney(summary.total)}</b> en este turno.
        </p>
      </Card>

      <div className="flex flex-col gap-3">
        <Button size="lg" onClick={() => setMovement("ingreso")}><ArrowDownCircle className="size-6 text-brand" /> Entró plata</Button>
        <Button size="lg" onClick={() => setMovement("egreso")}><ArrowUpCircle className="size-6 text-danger" /> Saqué plata</Button>
        {canClose ? (
          <Button size="lg" variant="primary" onClick={() => setClosing(true)} className="mt-2"><Lock className="size-6" /> Cerrar caja</Button>
        ) : (
          <p className="mt-2 rounded-xl bg-surface-2 px-4 py-3 text-muted">La caja la abrió {session.openedBy}: la cierra esa persona o un encargado.</p>
        )}
        {movements.length > 0 && (
          <Card className="mt-3">
            <h2 className="mb-2 font-bold">Movimientos</h2>
            <ul className="divide-y divide-line">
              {movements.map((m) => (
                <li key={m.id} className="flex justify-between gap-3 py-2">
                  <span><span className="text-muted">{formatTime(m.createdAt)}</span> {m.reason}</span>
                  <span className="num font-semibold">{m.type === "ingreso" ? "+" : "−"} {formatMoney(m.amount)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <MovementDialog type={movement} sessionId={session.id} onClose={() => setMovement(null)} />
      <CloseDialog open={closing} session={session} expected={expected} onClose={() => setClosing(false)} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line/60 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function MovementDialog({ type, sessionId, onClose }: { type: CashMovementType | null; sessionId: string; onClose: () => void }) {
  const [amount, setAmount] = useState<Cents | null>(null);
  const [reason, setReason] = useState("");
  const toast = useToast();
  const { user } = useSession();
  useEffect(() => {
    if (type) { setAmount(null); setReason(""); }
  }, [type]);
  const suggestions = type === "egreso" ? ["Pago a proveedor", "Retiro del dueño", "Gastos"] : ["Cambio", "Aporte del dueño"];
  const submit = async () => {
    if (!type || !amount || !reason.trim()) return;
    await addCashMovement(sessionId, type, amount, reason.trim(), user.name);
    toast({ tone: "ok", message: `${type === "ingreso" ? "Ingreso" : "Retiro"} de ${formatMoney(amount)} registrado` });
    onClose();
  };
  return (
    <Modal
      open={type !== null}
      onClose={onClose}
      title={type === "ingreso" ? "Entró plata a la caja" : "Saqué plata de la caja"}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={!amount || !reason.trim()}>Guardar</Button></>}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="¿Cuánto?">
          <MoneyInput value={amount} onChange={setAmount} placeholder="0" className="text-2xl font-bold" />
        </Field>
        <Field label="¿Por qué?">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: pago a proveedor" />
        </Field>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => <Button key={s} onClick={() => setReason(s)}>{s}</Button>)}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function CloseDialog({ open, session, expected, onClose }: { open: boolean; session: CashSession; expected: Cents; onClose: () => void }) {
  const [counted, setCounted] = useState<Cents | null>(null);
  const [note, setNote] = useState("");
  const toast = useToast();
  const { user } = useSession();
  useEffect(() => {
    if (open) { setCounted(null); setNote(""); }
  }, [open]);
  const diff = counted === null ? null : cashDifference(counted, expected);
  const submit = async () => {
    if (counted === null) return;
    await closeSession(session, counted, user.name, note.trim() || undefined);
    toast({ tone: "ok", message: "Caja cerrada. ¡Buen trabajo!" });
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cerrar la caja"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={counted === null}>Cerrar caja</Button></>}
    >
      <div className="flex flex-col gap-5">
        <p className="text-lg">Contá el efectivo del cajón y anotá cuánto hay. El sistema te dice si coincide.</p>
        <Field label="Efectivo contado">
          <MoneyInput value={counted} onChange={setCounted} placeholder="0" className="min-h-16 text-3xl font-bold" />
        </Field>
        {diff !== null && (
          <div className={cx("rounded-2xl px-5 py-4 text-xl", diff === 0 ? "bg-brand-soft" : diff > 0 ? "bg-warn-soft" : "bg-danger-soft")} aria-live="polite">
            <p className="num">Tendría que haber <b>{formatMoney(expected)}</b></p>
            <p className="num mt-1 text-2xl"><DiffLabel diff={diff} /></p>
          </div>
        )}
        {diff !== null && diff !== 0 && (
          <Field label="Nota (opcional)">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: di mal un vuelto" />
          </Field>
        )}
      </div>
    </Modal>
  );
}
