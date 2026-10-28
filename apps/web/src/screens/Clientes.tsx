import { useEffect, useMemo, useState } from "react";
import { HandCoins, MessageCircle, Pencil, Plus, Search, UserRound } from "lucide-react";
import {
  balanceOf, debtors, formatMoney, PAYMENT_LABELS, searchProducts, whatsappLink, type Cents, type PaymentMethod,
} from "@misventas/core";
import type { AccountMovement, Customer, Settings } from "../db";
import { createCustomer, registerDebtPayment, updateCustomer, useAccountMovements, useCustomers, type CustomerInput } from "../data/customers";
import { formatDate, plural } from "../lib/format";
import { Button, Card, cx, EmptyState, Field, inputClass, MoneyInput, Modal, PageHeader, Segmented, TextInput, useToast } from "../components/ui";
import { useSession } from "../components/Session";

const DAY = 86_400_000;

export function Clientes({ settings }: { settings: Settings }) {
  const customers = useCustomers();
  const movements = useAccountMovements();
  const [query, setQuery] = useState("");
  const [onlyDebtors, setOnlyDebtors] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Customer | "nuevo" | null>(null);

  const owed = useMemo(() => debtors(movements), [movements]);
  const owedMap = useMemo(() => new Map(owed.map((d) => [d.customerId, d])), [owed]);
  const totalOwed = owed.reduce((s, d) => s + d.balance, 0);

  const visible = useMemo(() => {
    const searchable = customers.map((c) => ({ ...c, barcodes: [c.phone, c.document].filter(Boolean) }));
    let list = query.trim() ? searchProducts(searchable, query, 500) : searchable;
    if (onlyDebtors && !query.trim()) list = list.filter((c) => owedMap.has(c.id));
    return [...list].sort((a, b) => (owedMap.get(b.id)?.balance ?? 0) - (owedMap.get(a.id)?.balance ?? 0));
  }, [customers, query, onlyDebtors, owedMap]);

  const selected = customers.find((c) => c.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-5xl p-4 lg:p-8">
      <PageHeader
        title="Fiado"
        subtitle="Clientes con cuenta corriente"
        actions={<Button variant="primary" onClick={() => setEditing("nuevo")}><Plus className="size-5" /> Nuevo cliente</Button>}
      />

      <Card className="mb-5 border-danger/30">
        <p className="text-lg font-semibold text-muted">Te deben en total</p>
        <p className="num mt-1 text-5xl font-extrabold">{formatMoney(totalOwed)}</p>
        <p className="mt-2 text-lg text-muted">{plural(owed.length, "cliente debe", "clientes deben")}</p>
      </Card>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nombre o teléfono" aria-label="Buscar cliente" className={cx(inputClass, "pl-11")} />
        </div>
        <Segmented
          label="Filtro"
          value={onlyDebtors ? "deben" : "todos"}
          onChange={(v) => setOnlyDebtors(v === "deben")}
          options={[{ value: "deben", label: "Los que deben" }, { value: "todos", label: "Todos" }]}
        />
      </div>

      <Card className="p-0">
        {visible.length === 0 ? (
          <EmptyState icon={<UserRound />} title={customers.length ? "Nadie debe nada" : "Todavía no hay clientes"}>
            {!customers.length && "Se crean desde acá o al cobrar con “Fiado”."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {visible.map((c) => {
              const d = owedMap.get(c.id);
              const days = d ? Math.floor((Date.now() - d.since) / DAY) : 0;
              return (
                <li key={c.id}>
                  <button type="button" onClick={() => setOpenId(c.id)} className="flex w-full items-center gap-4 px-5 py-3.5 text-left hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-lg font-semibold">{c.name}</span>
                      <span className="text-muted">{d ? (days === 0 ? "Debe desde hoy" : `Debe hace ${plural(days, "día", "días")}`) : c.phone || "Al día"}</span>
                    </span>
                    {d ? (
                      <span className="num rounded-lg bg-danger-soft px-3 py-1 text-xl font-bold text-danger">{formatMoney(d.balance)}</span>
                    ) : (
                      <span className="rounded-lg bg-surface-2 px-3 py-1 font-semibold">Al día</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {selected && (
        <CustomerDetail
          customer={selected}
          movements={movements.filter((m) => m.customerId === selected.id)}
          businessName={settings.businessName}
          methods={settings.enabledMethods.filter((m) => m !== "fiado")}
          onEdit={() => setEditing(selected)}
          onClose={() => setOpenId(null)}
        />
      )}
      <CustomerForm customer={editing === "nuevo" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} />
    </div>
  );
}

function CustomerDetail({ customer, movements, businessName, methods, onEdit, onClose }: {
  customer: Customer;
  movements: AccountMovement[];
  businessName: string;
  methods: PaymentMethod[];
  onEdit: () => void;
  onClose: () => void;
}) {
  const [paying, setPaying] = useState(false);
  const balance = balanceOf(movements, customer.id);
  const sorted = [...movements].sort((a, b) => a.createdAt - b.createdAt);
  let running = 0;
  const rows = sorted.map((m) => ({ m, after: (running += m.amount) })).reverse();
  const message = `Hola ${customer.name}, te escribimos de ${businessName || "el kiosco"}. Te recordamos que tenés un saldo pendiente de ${formatMoney(balance)}. ¡Gracias!`;
  const wa = customer.phone ? whatsappLink(customer.phone, message) : null;

  return (
    <Modal open onClose={onClose} title={customer.name} wide footer={
      <>
        <Button variant="ghost" className="mr-auto" onClick={onEdit}><Pencil className="size-5" /> Editar datos</Button>
        {balance > 0 && wa && (
          <a href={wa} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-line px-4 font-semibold hover:bg-surface-2">
            <MessageCircle className="size-5" /> Recordar por WhatsApp
          </a>
        )}
        {balance > 0 && <Button variant="primary" onClick={() => setPaying(true)}><HandCoins className="size-5" /> Registrar pago</Button>}
      </>
    }>
      <div className="flex flex-col gap-5">
        <div className={cx("rounded-2xl px-5 py-4", balance > 0 ? "bg-danger-soft" : "bg-surface-2")}>
          <p className="text-lg font-semibold">{balance > 0 ? "Debe" : balance < 0 ? "Tiene a favor" : "Está al día"}</p>
          <p className={cx("num text-5xl font-extrabold", balance > 0 && "text-danger")}>{formatMoney(Math.abs(balance))}</p>
          {customer.creditLimit !== null && <p className="num mt-1 text-muted">Límite de fiado: {formatMoney(customer.creditLimit)}</p>}
        </div>
        {balance > 0 && !customer.phone && <p className="text-muted">Cargale un teléfono para mandarle recordatorios por WhatsApp.</p>}
        {rows.length === 0 ? (
          <p className="text-muted">Todavía no tiene movimientos.</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr><th className="py-2 font-semibold">Fecha</th><th className="py-2 font-semibold">Detalle</th><th className="py-2 text-right font-semibold">Monto</th><th className="py-2 text-right font-semibold">Saldo</th></tr>
            </thead>
            <tbody className="num divide-y divide-line">
              {rows.map(({ m, after }) => (
                <tr key={m.id}>
                  <td className="py-2 pr-2 text-muted">{formatDate(m.createdAt)}</td>
                  <td className="py-2 pr-2">
                    {m.type === "compra" ? "Compra fiada" : m.type === "pago" ? `Pagó (${PAYMENT_LABELS[m.method ?? "efectivo"]})` : m.type === "anulacion" ? "Venta anulada" : "Ajuste"}
                  </td>
                  <td className={cx("py-2 text-right font-semibold", m.amount < 0 && "text-brand")}>{m.amount < 0 ? "−" : "+"}{formatMoney(Math.abs(m.amount))}</td>
                  <td className="py-2 text-right">{formatMoney(after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <PaymentDialog open={paying} customer={customer} balance={balance} methods={methods} onClose={() => setPaying(false)} />
    </Modal>
  );
}

function PaymentDialog({ open, customer, balance, methods, onClose }: {
  open: boolean;
  customer: Customer;
  balance: Cents;
  methods: PaymentMethod[];
  onClose: () => void;
}) {
  const [amount, setAmount] = useState<Cents | null>(balance);
  const [method, setMethod] = useState<PaymentMethod>("efectivo");
  const toast = useToast();
  const { user } = useSession();
  useEffect(() => {
    if (open) { setAmount(balance); setMethod(methods[0] ?? "efectivo"); }
  }, [open, balance, methods]);
  const submit = async () => {
    if (!amount || amount <= 0) return;
    try {
      await registerDebtPayment({ customer, amount, method, userName: user.name });
      toast({ tone: "ok", message: `${customer.name} pagó ${formatMoney(amount)}` });
      onClose();
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : "No se pudo registrar el pago." });
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Pago de ${customer.name}`} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={!amount}>Registrar pago</Button></>}>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="¿Cuánto paga?" hint={`Debe ${formatMoney(balance)}. Puede pagar una parte.`}>
          <MoneyInput value={amount} onChange={setAmount} className="text-2xl font-bold" />
        </Field>
        <Field label="¿Cómo paga?" group>
          <Segmented label="Medio de pago" value={method} onChange={setMethod} options={methods.map((m) => ({ value: m, label: PAYMENT_LABELS[m] }))} />
        </Field>
        {method === "efectivo" && <p className="text-muted">El efectivo entra a la caja abierta.</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function CustomerForm({ customer, open, onClose }: { customer: Customer | null; open: boolean; onClose: () => void }) {
  const [d, setD] = useState<CustomerInput>({ name: "", phone: "", document: "", creditLimit: null, notes: "" });
  const toast = useToast();
  useEffect(() => {
    if (open) setD(customer ? { name: customer.name, phone: customer.phone, document: customer.document, creditLimit: customer.creditLimit, notes: customer.notes } : { name: "", phone: "", document: "", creditLimit: null, notes: "" });
  }, [open, customer]);
  const save = async () => {
    if (!d.name.trim()) return;
    if (customer) await updateCustomer(customer.id, d);
    else await createCustomer(d);
    toast({ tone: "ok", message: `Guardaste a ${d.name.trim()}` });
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={customer ? "Editar cliente" : "Nuevo cliente"} footer={
      <>
        {customer && (
          <Button variant="ghost" className="mr-auto" onClick={async () => { await updateCustomer(customer.id, { active: false }); onClose(); }}>Archivar</Button>
        )}
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={save} disabled={!d.name.trim()}>Guardar</Button>
      </>
    }>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="sm:col-span-2"><Field label="Nombre"><TextInput value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Ej.: Juan del 3.º B" /></Field></div>
        <Field label="Teléfono (WhatsApp)"><TextInput inputMode="tel" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} placeholder="11 1234 5678" /></Field>
        <Field label="DNI (opcional)"><TextInput inputMode="numeric" value={d.document} onChange={(e) => setD({ ...d, document: e.target.value })} /></Field>
        <Field label="Límite de fiado (opcional)" hint="Te avisa si al fiarle se pasa de este monto.">
          <MoneyInput value={d.creditLimit} onChange={(creditLimit) => setD({ ...d, creditLimit })} placeholder="Sin límite" />
        </Field>
        <Field label="Notas"><TextInput value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
