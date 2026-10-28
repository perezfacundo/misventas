import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ClipboardCopy, MessageCircle, PackagePlus, Pencil, Plus, Truck } from "lucide-react";
import { formatMoney, stockStatus, whatsappLink } from "@misventas/core";
import { db, type Product, type Settings, type Supplier } from "../db";
import { useProducts } from "../data/products";
import { createSupplier, updateSupplier, useSuppliers, WEEKDAYS, type SupplierInput } from "../data/suppliers";
import { formatDate, plural } from "../lib/format";
import { Button, Card, cx, EmptyState, Field, Modal, PageHeader, TextInput, useToast } from "../components/ui";
import { PurchaseDialog } from "../components/PurchaseDialog";
import { ProductForm } from "../components/ProductForm";

const isMissing = (p: Product) => p.trackStock && stockStatus(p.stock, p.minStock) !== "ok";
/** Cantidad sugerida para pedir: reponer hasta el doble del mínimo. */
const suggested = (p: Product) => Math.max(1, p.minStock * 2 - Math.max(0, p.stock));

export function Proveedores({ settings }: { settings: Settings }) {
  const suppliers = useSuppliers();
  const products = useProducts();
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Supplier | "nuevo" | null>(null);
  const today = new Date().getDay();

  const bySupplier = useMemo(() => {
    const map = new Map<string | null, Product[]>();
    for (const p of products) map.set(p.supplierId, [...(map.get(p.supplierId) ?? []), p]);
    return map;
  }, [products]);
  const orphanMissing = (bySupplier.get(null) ?? []).filter(isMissing);
  const selected = suppliers.find((s) => s.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-5xl p-4 lg:p-8">
      <PageHeader
        title="Proveedores"
        subtitle="Quién te trae cada cosa y qué hay que pedirle"
        actions={<Button variant="primary" onClick={() => setEditing("nuevo")}><Plus className="size-5" /> Nuevo proveedor</Button>}
      />
      {suppliers.length === 0 ? (
        <Card><EmptyState icon={<Truck />} title="Todavía no hay proveedores">Cargalos acá o escribí el nombre al editar un producto.</EmptyState></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {suppliers.map((s) => {
            const list = bySupplier.get(s.id) ?? [];
            const missing = list.filter(isMissing).length;
            const comesToday = s.visitDays.includes(today);
            return (
              <button key={s.id} type="button" onClick={() => setOpenId(s.id)} className="rounded-2xl border border-line bg-surface p-5 text-left shadow-sm hover:border-brand">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xl font-bold">{s.name}</p>
                  {comesToday && <span className="rounded-lg bg-brand-soft px-2.5 py-1 text-sm font-semibold">Viene hoy</span>}
                </div>
                <p className="mt-1 text-muted">
                  {s.visitDays.length ? `Viene: ${s.visitDays.map((d) => WEEKDAYS[d]).join(", ")}` : "Sin días de visita"} · {plural(list.length, "producto", "productos")}
                </p>
                <p className={cx("mt-3 text-lg font-semibold", missing ? "text-warn" : "text-muted")}>
                  {missing ? `Hay que pedirle ${plural(missing, "producto", "productos")}` : "No falta nada"}
                </p>
              </button>
            );
          })}
        </div>
      )}

      {orphanMissing.length > 0 && (
        <Card className="mt-6">
          <h2 className="text-xl font-bold">Faltan y no tienen proveedor</h2>
          <p className="mb-3 text-muted">Asignales uno desde Productos para que aparezcan en su pedido.</p>
          <p>{orphanMissing.map((p) => p.name).join(", ")}</p>
        </Card>
      )}

      {selected && (
        <SupplierDetail
          supplier={selected}
          products={bySupplier.get(selected.id) ?? []}
          allProducts={products}
          suppliers={suppliers}
          businessName={settings.businessName}
          onEdit={() => setEditing(selected)}
          onClose={() => setOpenId(null)}
        />
      )}
      <SupplierForm supplier={editing === "nuevo" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} />
    </div>
  );
}

function SupplierDetail({ supplier, products, allProducts, suppliers, businessName, onEdit, onClose }: {
  supplier: Supplier;
  products: Product[];
  allProducts: Product[];
  suppliers: Supplier[];
  businessName: string;
  onEdit: () => void;
  onClose: () => void;
}) {
  const missing = products.filter(isMissing);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [receiving, setReceiving] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const toast = useToast();
  const purchases = useLiveQuery(
    () => db.purchases.where("supplierId").equals(supplier.id).reverse().sortBy("createdAt").then((ps) => ps.slice(0, 5)),
    [supplier.id],
    [],
  );

  useEffect(() => {
    setQty(Object.fromEntries(products.filter(isMissing).map((p) => [p.id, String(suggested(p))])));
    // Se recalcula al abrir otro proveedor, no con cada cambio de stock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplier.id]);

  const order = missing.filter((p) => Number(qty[p.id] ?? 0) > 0).map((p) => `• ${qty[p.id]} × ${p.name}`);
  const message = `Hola${supplier.contact ? ` ${supplier.contact}` : ""}, te paso el pedido de ${businessName || "el kiosco"}:\n${order.join("\n")}\n¡Gracias!`;
  const wa = supplier.phone ? whatsappLink(supplier.phone, message) : null;

  return (
    <Modal open onClose={onClose} title={supplier.name} wide footer={
      <>
        <Button variant="ghost" className="mr-auto" onClick={onEdit}><Pencil className="size-5" /> Editar</Button>
        <Button onClick={() => setReceiving(true)}><PackagePlus className="size-5" /> Llegó mercadería</Button>
      </>
    }>
      <div className="flex flex-col gap-5">
        <p className="text-muted">
          {[supplier.contact, supplier.phone, supplier.visitDays.length ? `Viene: ${supplier.visitDays.map((d) => WEEKDAYS[d]).join(", ")}` : ""].filter(Boolean).join(" · ") || "Sin datos de contacto"}
        </p>

        <section>
          <h3 className="mb-2 text-lg font-bold">Para pedir</h3>
          {missing.length === 0 ? (
            <p className="text-muted">No falta nada de este proveedor.</p>
          ) : (
            <>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {missing.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="flex-1">
                      <span className="block font-semibold">{p.name}</span>
                      <span className="text-sm text-muted">Hay {p.stock} · mínimo {p.minStock}</span>
                    </span>
                    <TextInput inputMode="numeric" aria-label={`Cantidad a pedir de ${p.name}`} value={qty[p.id] ?? ""} onChange={(e) => setQty({ ...qty, [p.id]: e.target.value })} className="w-20! text-center" />
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                {wa && (
                  <a href={wa} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-brand-ink hover:bg-brand-hover">
                    <MessageCircle className="size-5" /> Enviar pedido por WhatsApp
                  </a>
                )}
                <Button onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(message);
                    toast({ tone: "ok", message: "Pedido copiado. Pegalo donde quieras." });
                  } catch {
                    toast({ tone: "error", message: "No se pudo copiar." });
                  }
                }}>
                  <ClipboardCopy className="size-5" /> Copiar pedido
                </Button>
              </div>
            </>
          )}
        </section>

        {purchases.length > 0 && (
          <section>
            <h3 className="mb-2 text-lg font-bold">Últimas entregas</h3>
            <ul className="num divide-y divide-line">
              {purchases.map((p) => (
                <li key={p.id} className="flex justify-between gap-3 py-2">
                  <span>{formatDate(p.createdAt)} · {plural(p.items.reduce((s, i) => s + i.quantity, 0), "unidad", "unidades")}</span>
                  <span className="font-semibold">{p.total ? formatMoney(p.total) : ""}{p.paidFromCash ? " (de la caja)" : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <PurchaseDialog
        open={receiving}
        products={allProducts}
        suppliers={suppliers}
        defaultSupplierId={supplier.id}
        onClose={() => setReceiving(false)}
        onUnknownCode={(code) => { setReceiving(false); setCreating(code); }}
      />
      <ProductForm open={creating !== null} product={null} products={allProducts} suppliers={suppliers} prefillBarcode={creating ?? undefined} onClose={() => setCreating(null)} />
    </Modal>
  );
}

function SupplierForm({ supplier, open, onClose }: { supplier: Supplier | null; open: boolean; onClose: () => void }) {
  const empty: SupplierInput = { name: "", phone: "", contact: "", visitDays: [], notes: "" };
  const [d, setD] = useState<SupplierInput>(empty);
  const toast = useToast();
  useEffect(() => {
    if (open) setD(supplier ? { name: supplier.name, phone: supplier.phone, contact: supplier.contact, visitDays: supplier.visitDays, notes: supplier.notes } : empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, supplier]);
  const save = async () => {
    if (!d.name.trim()) return;
    if (supplier) await updateSupplier(supplier.id, d);
    else await createSupplier(d);
    toast({ tone: "ok", message: `Guardaste ${d.name.trim()}` });
    onClose();
  };
  const toggleDay = (day: number) =>
    setD({ ...d, visitDays: d.visitDays.includes(day) ? d.visitDays.filter((x) => x !== day) : [...d.visitDays, day].sort() });
  return (
    <Modal open={open} onClose={onClose} title={supplier ? "Editar proveedor" : "Nuevo proveedor"} footer={
      <>
        {supplier && <Button variant="ghost" className="mr-auto" onClick={async () => { await updateSupplier(supplier.id, { active: false }); onClose(); }}>Archivar</Button>}
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={save} disabled={!d.name.trim()}>Guardar</Button>
      </>
    }>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="sm:col-span-2"><Field label="Nombre"><TextInput value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Ej.: Distribuidora Norte" /></Field></div>
        <Field label="Persona de contacto"><TextInput value={d.contact} onChange={(e) => setD({ ...d, contact: e.target.value })} placeholder="Ej.: Carlos" /></Field>
        <Field label="Teléfono (WhatsApp)"><TextInput inputMode="tel" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} /></Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-semibold text-muted">¿Qué días viene?</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Días de visita">
            {WEEKDAYS.map((label, day) => (
              <button key={label} type="button" aria-pressed={d.visitDays.includes(day)} onClick={() => toggleDay(day)}
                className={cx("min-h-12 min-w-14 rounded-xl border font-semibold", d.visitDays.includes(day) ? "border-brand bg-brand-soft ring-2 ring-brand/40" : "border-line")}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="sm:col-span-2"><Field label="Notas"><TextInput value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Ej.: pedir antes del mediodía" /></Field></div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
