import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { ArrowLeftRight, Banknote, CheckCircle2, CreditCard, Loader2, NotebookPen, Plus, QrCode, Smartphone, Trash2, UserPlus } from "lucide-react";
import {
  balanceOf, checkCreditLimit, formatMoney, PAYMENT_LABELS, searchProducts, settle, suggestCashAmounts,
  type Cents, type Payment, type PaymentMethod, type TenderInput,
} from "@misventas/core";
import type { Customer } from "../db";
import { createCustomer, useAccountMovements, useCustomers } from "../data/customers";
import { useOnline } from "../lib/hooks";
import {
  cancelCharge, createCharge, forgetCharge, providerOf, rememberCharge, useMpAvailability, watchCharge,
  type Charge, type ChargeKind,
} from "../payments/mercadopago";
import { Button, cx, inputClass, Kbd, MoneyInput, Modal, TextInput, useToast } from "./ui";

const ICONS: Record<PaymentMethod, typeof Banknote> = {
  efectivo: Banknote,
  debito: CreditCard,
  credito: CreditCard,
  transferencia: ArrowLeftRight,
  mercadopago: QrCode,
  fiado: NotebookPen,
};

interface Tender {
  method: PaymentMethod;
  /** null = no cargado todavía. */
  amount: Cents | null;
  reference: string;
  /** Cobro integrado con Mercado Pago (QR o Point), si se inició uno. */
  charge?: Charge;
}

const isLocked = (t: Tender | undefined) => t?.charge?.status === "pendiente" || t?.charge?.status === "pagado";

export function CobroDialog({
  open, total, methods, resume, onClose, onConfirm,
}: {
  open: boolean;
  total: Cents;
  methods: PaymentMethod[];
  /** Cobro de Mercado Pago que quedó en curso (por ejemplo, si la app se cerró mientras el cliente pagaba). */
  resume?: Charge | null;
  onClose: () => void;
  onConfirm: (payments: Payment[], change: Cents, customerId?: string) => Promise<void>;
}) {
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const mpPendingRef = useRef(false);
  const toast = useToast();
  const online = useOnline();
  const mp = useMpAvailability();

  useEffect(() => {
    if (open) {
      setTenders(
        resume
          ? [{ method: "mercadopago", amount: resume.amount, reference: "", charge: resume }]
          : [{ method: methods[0] ?? "efectivo", amount: null, reference: "" }],
      );
      setActive(0);
      setBusy(false);
      setCustomer(null);
    }
  }, [open, methods, resume]);

  // Montos sin cargar: con un solo medio se asume que paga justo; si hay varios,
  // el primer medio electrónico sin monto toma "el resto" y el efectivo sin monto cuenta 0.
  const fixedSum = tenders.reduce((s, t) => s + (t.amount ?? 0), 0);
  const restIndex = tenders.findIndex((t) => t.amount === null && t.method !== "efectivo");
  const effective: TenderInput[] = tenders.map((t, i) => {
    const paid = t.charge?.status === "pagado" ? t.charge : undefined;
    return {
      method: t.method,
      amount: t.amount ?? (tenders.length === 1 ? total : i === restIndex ? Math.max(0, total - fixedSum) : 0),
      reference: paid?.paymentId ?? t.reference,
      ...(paid ? { provider: providerOf(paid.kind), chargeId: paid.id } : {}),
    };
  });
  const result = settle(total, effective);
  const fiado = effective.filter((t) => t.method === "fiado").reduce((sum, t) => sum + t.amount, 0);
  const needsCustomer = fiado > 0 && !customer;
  const waiting = tenders.some((t) => t.charge?.status === "pendiente");
  const canConfirm = result.ok && !needsCustomer && !busy && !waiting;
  const othersSum = (i: number) => effective.reduce((s, t, j) => (j === i ? s : s + t.amount), 0);

  const update = (i: number, patch: Partial<Tender>) =>
    setTenders((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const pickMethod = (method: PaymentMethod) => {
    const current = tenders[active];
    if (!current || isLocked(current)) return;
    // Al pasar a un medio electrónico se descarta el monto tipeado: no hay vuelto, cobra lo que corresponde.
    update(active, { method, amount: method === "efectivo" ? current.amount : null });
  };

  const addTender = () => {
    const used = new Set(tenders.map((t) => t.method));
    const method = methods.find((m) => m !== "efectivo" && !used.has(m)) ?? methods.find((m) => !used.has(m)) ?? "efectivo";
    setTenders((ts) => [...ts, { method, amount: null, reference: "" }]);
    setActive(tenders.length);
  };

  const removeTender = (i: number) => {
    setTenders((ts) => ts.filter((_, j) => j !== i));
    setActive(0);
  };

  const confirm = async () => {
    if (!result.ok || !canConfirm) return;
    setBusy(true);
    try {
      await onConfirm(result.payments, result.change, fiado > 0 ? customer!.id : undefined);
    } finally {
      setBusy(false);
    }
  };

  // --- Mercado Pago integrado ---

  const updateCharge = (charge: Charge) => {
    setTenders((ts) => ts.map((t) => (t.charge?.id === charge.id ? { ...t, charge } : t)));
    if (charge.status === "fallido") forgetCharge();
  };

  const startCharge = async (kind: ChargeKind) => {
    const amount = effective[active]?.amount ?? 0;
    if (amount <= 0 || starting) return;
    setStarting(true);
    try {
      const charge = await createCharge({ id: crypto.randomUUID(), kind, amount });
      rememberCharge(charge);
      update(active, { amount, charge });
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : "No se pudo iniciar el cobro." });
    } finally {
      setStarting(false);
    }
  };

  /** Cancela el cobro en curso. Devuelve false si no se pudo (por ejemplo, ya está en el posnet). */
  const cancelPending = async (): Promise<boolean> => {
    const pending = tenders.find((t) => t.charge?.status === "pendiente")?.charge;
    if (!pending) return true;
    try {
      const charge = await cancelCharge(pending.id);
      updateCharge(charge);
      if (charge.status === "pagado") {
        toast({ tone: "ok", message: "El cliente ya había pagado: el cobro quedó registrado." });
        return false;
      }
      forgetCharge();
      return true;
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : "No se pudo cancelar el cobro." });
      return false;
    }
  };

  const handleClose = async () => {
    if (await cancelPending()) onClose();
  };

  // Seguir los cobros pendientes hasta que se paguen o fallen.
  const pendingIds = tenders.filter((t) => t.charge?.status === "pendiente").map((t) => t.charge!.id).join(",");
  useEffect(() => {
    if (!open || !pendingIds) return;
    const stops = pendingIds.split(",").map((id) => watchCharge(id, updateCharge));
    return () => stops.forEach((stop) => stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pendingIds]);

  // Cuando entra el pago y no falta nada, la venta se registra sola.
  const autoConfirmed = useRef<string | null>(null);
  const paidIds = tenders.filter((t) => t.charge?.status === "pagado").map((t) => t.charge!.id).join(",");
  useEffect(() => {
    if (!open || !paidIds || autoConfirmed.current === paidIds || !canConfirm) return;
    autoConfirmed.current = paidIds;
    void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paidIds, canConfirm]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        // Con Mercado Pago integrado sin cobrar, Enter no confirma: registrarlo "a mano" tiene que ser a propósito.
        if (!mpPendingRef.current) void confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const current = tenders[active];
  const mpPanel = current?.method === "mercadopago" && Boolean(current.charge || (mp && (mp.qr || mp.point)));
  // Mercado Pago integrado elegido pero sin cobro iniciado: no está pagado todavía.
  const mpPending = tenders.some((t) => t.method === "mercadopago" && t.charge?.status !== "pagado" && t.charge?.status !== "pendiente") && Boolean(mp && (mp.qr || mp.point));
  mpPendingRef.current = mpPending;

  return (
    <Modal
      open={open}
      onClose={() => void handleClose()}
      title="Cobrar"
      wide
      footer={
        <>
          {/* El vuelto va en el pie fijo: en el celular siempre está a la vista, sin scroll. */}
          <div aria-live="polite" className="w-full">
            {waiting ? (
              <p className="flex items-center gap-2 rounded-2xl bg-surface-2 px-5 py-3 text-xl font-bold">
                <Loader2 className="size-6 animate-spin text-brand" /> Esperando el pago de Mercado Pago…
              </p>
            ) : mpPending ? (
              <p className="rounded-2xl bg-warn-soft px-5 py-3 text-lg font-bold text-warn">
                Tocá «Cobrar con {mp?.qr ? "QR" : "Point"}». Si ya lo cobraste por fuera, confirmá abajo.
              </p>
            ) : null}
            {!waiting && !mpPending && result.ok && result.change > 0 && (
              <div className="flex items-baseline justify-between rounded-2xl bg-brand-soft px-5 py-3">
                <span className="text-xl font-bold">Vuelto</span>
                <span className="num text-5xl font-extrabold text-brand sm:text-6xl">{formatMoney(result.change)}</span>
              </div>
            )}
            {!waiting && !mpPending && result.ok && result.change === 0 && (
              <p className="rounded-2xl bg-brand-soft px-5 py-3 text-xl font-bold">Pago completo, sin vuelto.</p>
            )}
            {!result.ok && result.reason === "falta" && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-warn-soft px-5 py-3">
                <span className="text-xl font-bold text-warn">Faltan <span className="num">{formatMoney(result.remaining)}</span></span>
                <Button onClick={addTender}><Plus className="size-5" /> Pagar el resto con otro medio</Button>
              </div>
            )}
            {!result.ok && result.reason === "excede-sin-efectivo" && (
              <p className="rounded-2xl bg-danger-soft px-5 py-3 text-lg font-bold text-danger">
                Con tarjeta, transferencia o Mercado Pago no se puede cobrar de más: sobran {formatMoney(result.excess)}.
              </p>
            )}
          </div>
          <Button size="lg" onClick={() => void handleClose()}>Volver</Button>
          {needsCustomer && result.ok && <p className="w-full font-semibold text-warn">Elegí a quién se le fía para poder confirmar.</p>}
          <Button size="lg" variant="primary" onClick={confirm} disabled={!canConfirm} className="min-w-56">
            {mpPending ? "Ya lo cobré, confirmar" : "Confirmar cobro"} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-baseline justify-between rounded-2xl bg-surface-2 px-5 py-4">
          <span className="text-lg font-semibold text-muted">Total a cobrar</span>
          <span className="num text-5xl font-extrabold">{formatMoney(total)}</span>
        </div>

        {tenders.length > 1 && (
          <ul className="flex flex-col gap-2" aria-label="Medios de pago">
            {tenders.map((t, i) => (
              <li key={i}>
                <div
                  className={cx(
                    "flex items-center gap-3 rounded-xl border px-4 py-2.5",
                    i === active ? "border-brand ring-2 ring-brand/30" : "border-line",
                  )}
                >
                  <button type="button" className="flex flex-1 items-center justify-between text-left" onClick={() => setActive(i)}>
                    <span className="font-semibold">{PAYMENT_LABELS[t.method]}{t.charge?.status === "pagado" && " ✓"}</span>
                    <span className="num text-lg font-bold">{formatMoney(effective[i]!.amount)}</span>
                  </button>
                  <button type="button" onClick={() => removeTender(i)} disabled={isLocked(t)} className="rounded-lg p-2 text-muted hover:bg-surface-2 disabled:opacity-30" aria-label={`Quitar ${PAYMENT_LABELS[t.method]}`}>
                    <Trash2 className="size-5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div>
          <p className="mb-2 text-sm font-semibold text-muted">{tenders.length > 1 ? "Medio seleccionado" : "¿Cómo paga?"}</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Medio de pago">
            {methods.map((m) => {
              const Icon = ICONS[m];
              const selected = current?.method === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => pickMethod(m)}
                  disabled={isLocked(current) && !selected}
                  className={cx(
                    "flex min-h-16 flex-col items-center justify-center gap-1 rounded-2xl border-2 px-1 text-sm font-semibold transition-colors sm:min-h-18 sm:text-base",
                    selected ? "border-brand bg-brand-soft" : "border-line bg-surface hover:bg-surface-2",
                  )}
                >
                  <Icon className={cx("size-6 sm:size-7", selected && "text-brand")} />
                  {PAYMENT_LABELS[m]}
                </button>
              );
            })}
          </div>
        </div>

        {current && current.method === "efectivo" && (
          <div className="flex flex-col gap-3">
            <label className="text-sm font-semibold text-muted" htmlFor="cash-amount">¿Con cuánto paga?</label>
            <MoneyInput
              id="cash-amount"
              value={current.amount}
              onChange={(amount) => update(active, { amount })}
              placeholder={tenders.length === 1 ? `${total / 100} (justo)` : "0"}
              className="min-h-16 text-3xl font-bold"
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {suggestCashAmounts(tenders.length === 1 ? total : Math.max(0, total - othersSum(active))).map((v, i) => (
                <Button key={v} size="lg" onClick={() => update(active, { amount: v })} className="num whitespace-nowrap px-2">
                  {i === 0 ? `Justo ${formatMoney(v)}` : formatMoney(v)}
                </Button>
              ))}
            </div>
          </div>
        )}

        {tenders.some((t) => t.method === "fiado") && (
          <FiadoCustomer customer={customer} onChange={setCustomer} amount={fiado} />
        )}

        {current && mpPanel && (
          <MercadoPagoPanel
            charge={current.charge}
            amount={effective[active]!.amount}
            available={mp ?? { qr: false, point: false }}
            online={online}
            starting={starting}
            onStart={startCharge}
            onCancel={() => void cancelPending()}
            onAmountChange={(amount) => update(active, { amount })}
          />
        )}

        {current && current.method !== "efectivo" && current.method !== "fiado" && !isLocked(current) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {!mpPanel && (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-muted">Monto</span>
                <MoneyInput value={current.amount ?? effective[active]!.amount} onChange={(amount) => update(active, { amount })} className="text-2xl font-bold" />
              </label>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-muted">
                {mpPanel ? "¿Lo cobraste por fuera? N.º de operación (opcional)" : "N.º de operación (opcional)"}
              </span>
              <TextInput value={current.reference} onChange={(e) => update(active, { reference: e.target.value })} placeholder="Del posnet o la transferencia" />
            </label>
          </div>
        )}

        {tenders.length === 1 && result.ok && (
          <button type="button" onClick={addTender} className="self-start text-base font-semibold text-muted underline underline-offset-4 hover:text-ink">
            Paga con dos medios (por ejemplo, parte en efectivo y parte con tarjeta)
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Elegir (o crear en el momento) el cliente al que se le fía, viendo cuánto debe. */
function FiadoCustomer({ customer, onChange, amount }: { customer: Customer | null; onChange: (c: Customer | null) => void; amount: Cents }) {
  const customers = useCustomers();
  const movements = useAccountMovements();
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () => (query.trim() ? searchProducts(customers.map((c) => ({ ...c, barcodes: [c.phone, c.document].filter(Boolean) })), query, 6) : customers.slice(0, 6)),
    [customers, query],
  );

  if (customer) {
    const balance = balanceOf(movements, customer.id);
    const check = checkCreditLimit(balance, amount, customer.creditLimit);
    return (
      <div className={cx("flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-3", check.ok ? "bg-surface-2" : "bg-warn-soft")}>
        <div>
          <p className="text-lg font-bold">Se le fía a {customer.name}</p>
          <p className="num text-muted">
            Debe {formatMoney(balance)} → quedaría en <b className="text-ink">{formatMoney(balance + amount)}</b>
            {customer.creditLimit !== null && ` · Límite ${formatMoney(customer.creditLimit)}`}
          </p>
          {!check.ok && <p className="font-semibold text-warn">Supera el límite por {formatMoney(check.exceededBy)}.</p>}
        </div>
        <Button onClick={() => onChange(null)}>Cambiar</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-semibold text-muted" htmlFor="fiado-cliente">¿A quién se le fía?</label>
      <input id="fiado-cliente" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscá por nombre o teléfono" className={inputClass} autoComplete="off" />
      <div className="flex flex-wrap gap-2">
        {matches.map((c) => (
          <Button key={c.id} onClick={() => onChange(c)}>
            {c.name} <span className="num text-muted">· {formatMoney(balanceOf(movements, c.id))}</span>
          </Button>
        ))}
        {query.trim() && !customers.some((c) => c.name.toLowerCase() === query.trim().toLowerCase()) && (
          <Button
            variant="ghost"
            onClick={async () => onChange(await createCustomer({ name: query, phone: "", document: "", creditLimit: null, notes: "" }))}
          >
            <UserPlus className="size-5" /> Nuevo cliente: {query.trim()}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Cobro con Mercado Pago integrado: iniciar con QR o Point, esperar el pago y mostrar el resultado. */
function MercadoPagoPanel({ charge, amount, available, online, starting, onStart, onCancel, onAmountChange }: {
  charge?: Charge;
  amount: Cents;
  available: { qr: boolean; point: boolean };
  online: boolean;
  starting: boolean;
  onStart: (kind: ChargeKind) => void;
  onCancel: () => void;
  onAmountChange: (amount: Cents | null) => void;
}) {
  if (charge?.status === "pagado") {
    return (
      <div className="flex items-center gap-4 rounded-2xl bg-brand-soft px-5 py-4" role="status">
        <CheckCircle2 className="size-9 shrink-0 text-brand" />
        <div>
          <p className="text-xl font-bold">Cobrado con Mercado Pago <span className="num">{formatMoney(charge.amount)}</span></p>
          {charge.paymentId && <p className="text-muted">Operación {charge.paymentId}</p>}
        </div>
      </div>
    );
  }
  if (charge?.status === "pendiente") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-brand/40 bg-surface-2 px-5 py-5 text-center sm:flex-row sm:text-left" role="status">
        {charge.kind === "qr" && charge.qrData ? (
          <QrImage data={charge.qrData} />
        ) : (
          <Smartphone className="size-16 shrink-0 text-brand" />
        )}
        <div className="flex flex-1 flex-col gap-2">
          <p className="num text-3xl font-extrabold">{formatMoney(charge.amount)}</p>
          <p className="text-lg font-semibold">
            {charge.kind === "qr" ? "Pedile al cliente que escanee el QR con Mercado Pago o la app de su banco." : "El cobro está en el posnet: que el cliente pase o acerque la tarjeta."}
          </p>
          <p className="flex items-center justify-center gap-2 text-muted sm:justify-start">
            <Loader2 className="size-5 animate-spin" /> Esperando el pago…
          </p>
          {charge.message && <p className="font-semibold text-warn">{charge.message}</p>}
          <Button variant="ghost" onClick={onCancel} className="self-center sm:self-start">Cancelar este cobro</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {charge?.status === "fallido" && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger">{charge.message ?? "El cobro no se completó."}</p>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-muted">Monto a cobrar con Mercado Pago</span>
        <MoneyInput value={amount} onChange={onAmountChange} className="text-2xl font-bold" />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {available.qr && (
          <Button variant="primary" size="lg" disabled={!online || starting || amount <= 0} onClick={() => onStart("qr")}>
            <QrCode className="size-6" /> Cobrar con QR
          </Button>
        )}
        {available.point && (
          <Button variant="primary" size="lg" disabled={!online || starting || amount <= 0} onClick={() => onStart("point")}>
            <CreditCard className="size-6" /> Cobrar con Point
          </Button>
        )}
      </div>
      {!online && <p className="font-semibold text-warn">Sin internet no se puede cobrar con Mercado Pago. Usá otro medio o registralo a mano.</p>}
    </div>
  );
}

function QrImage({ data }: { data: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(data, { margin: 1, width: 240, errorCorrectionLevel: "M" }).then((url) => !cancelled && setSrc(url));
    return () => {
      cancelled = true;
    };
  }, [data]);
  return src ? (
    <img src={src} alt="Código QR para pagar con Mercado Pago" className="size-48 shrink-0 rounded-xl bg-white p-2" />
  ) : (
    <div className="size-48 shrink-0 rounded-xl bg-white" />
  );
}
