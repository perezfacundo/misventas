import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Banknote, CreditCard, NotebookPen, Plus, QrCode, Trash2, UserPlus } from "lucide-react";
import {
  balanceOf, checkCreditLimit, formatMoney, PAYMENT_LABELS, searchProducts, settle, suggestCashAmounts,
  type Cents, type Payment, type PaymentMethod, type TenderInput,
} from "@misventas/core";
import type { Customer } from "../db";
import { createCustomer, useAccountMovements, useCustomers } from "../data/customers";
import { Button, cx, inputClass, Kbd, MoneyInput, Modal, TextInput } from "./ui";

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
}

export function CobroDialog({
  open, total, methods, onClose, onConfirm,
}: {
  open: boolean;
  total: Cents;
  methods: PaymentMethod[];
  onClose: () => void;
  onConfirm: (payments: Payment[], change: Cents, customerId?: string) => Promise<void>;
}) {
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTenders([{ method: methods[0] ?? "efectivo", amount: null, reference: "" }]);
      setActive(0);
      setBusy(false);
      setCustomer(null);
    }
  }, [open, methods]);

  // Montos sin cargar: con un solo medio se asume que paga justo; si hay varios,
  // el primer medio electrónico sin monto toma "el resto" y el efectivo sin monto cuenta 0.
  const fixedSum = tenders.reduce((s, t) => s + (t.amount ?? 0), 0);
  const restIndex = tenders.findIndex((t) => t.amount === null && t.method !== "efectivo");
  const effective: TenderInput[] = tenders.map((t, i) => ({
    method: t.method,
    amount: t.amount ?? (tenders.length === 1 ? total : i === restIndex ? Math.max(0, total - fixedSum) : 0),
    reference: t.reference,
  }));
  const result = settle(total, effective);
  const fiado = effective.filter((t) => t.method === "fiado").reduce((sum, t) => sum + t.amount, 0);
  const needsCustomer = fiado > 0 && !customer;
  const canConfirm = result.ok && !needsCustomer && !busy;
  const othersSum = (i: number) => effective.reduce((s, t, j) => (j === i ? s : s + t.amount), 0);

  const update = (i: number, patch: Partial<Tender>) =>
    setTenders((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const pickMethod = (method: PaymentMethod) => {
    const current = tenders[active];
    if (!current) return;
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const current = tenders[active];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cobrar"
      wide
      footer={
        <>
          {/* El vuelto va en el pie fijo: en el celular siempre está a la vista, sin scroll. */}
          <div aria-live="polite" className="w-full">
            {result.ok && result.change > 0 && (
              <div className="flex items-baseline justify-between rounded-2xl bg-brand-soft px-5 py-3">
                <span className="text-xl font-bold">Vuelto</span>
                <span className="num text-5xl font-extrabold text-brand sm:text-6xl">{formatMoney(result.change)}</span>
              </div>
            )}
            {result.ok && result.change === 0 && (
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
          <Button size="lg" onClick={onClose}>Volver</Button>
          {needsCustomer && result.ok && <p className="w-full font-semibold text-warn">Elegí a quién se le fía para poder confirmar.</p>}
          <Button size="lg" variant="primary" onClick={confirm} disabled={!canConfirm} className="min-w-56">
            Confirmar cobro <Kbd>Enter</Kbd>
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
                    <span className="font-semibold">{PAYMENT_LABELS[t.method]}</span>
                    <span className="num text-lg font-bold">{formatMoney(effective[i]!.amount)}</span>
                  </button>
                  <button type="button" onClick={() => removeTender(i)} className="rounded-lg p-2 text-muted hover:bg-surface-2" aria-label={`Quitar ${PAYMENT_LABELS[t.method]}`}>
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

        {current && current.method !== "efectivo" && current.method !== "fiado" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-muted">Monto</span>
              <MoneyInput value={current.amount ?? effective[active]!.amount} onChange={(amount) => update(active, { amount })} className="text-2xl font-bold" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-muted">N.º de operación (opcional)</span>
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
