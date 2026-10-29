import { useEffect, useMemo, useState } from "react";
import { BadgePercent, Plus, Search, Trash2, X } from "lucide-react";
import { describePromotion, formatMoney, isPromotionActive, searchProducts, type Cents, type PromotionKind, type PromotionSchedule } from "@misventas/core";
import type { Product, PromotionRecord } from "../db";
import { catalogOptions, useProducts } from "../data/products";
import { deletePromotion, savePromotion, setPromotionActive, usePromotions, type PromotionInput } from "../data/promotions";
import { WEEKDAYS } from "../data/suppliers";
import { useNow } from "../lib/hooks";
import { Button, Card, cx, EmptyState, Field, inputClass, MoneyInput, Modal, PageHeader, Segmented, TextInput, Toggle, useToast } from "../components/ui";

const dmy = (iso: string) => iso.split("-").reverse().join("/");

function scheduleText(s: PromotionSchedule | undefined): string {
  if (!s) return "Siempre";
  const parts: string[] = [];
  if (s.weekdays?.length) parts.push(s.weekdays.map((d) => WEEKDAYS[d]).join(", "));
  if (s.fromTime && s.toTime) parts.push(`de ${s.fromTime} a ${s.toTime} h`);
  if (s.from && s.to) parts.push(`del ${dmy(s.from)} al ${dmy(s.to)}`);
  else if (s.from) parts.push(`desde el ${dmy(s.from)}`);
  else if (s.to) parts.push(`hasta el ${dmy(s.to)}`);
  return parts.join(" · ") || "Siempre";
}

export function Promociones() {
  const promotions = usePromotions();
  const products = useProducts();
  const now = useNow(60_000);
  const [editing, setEditing] = useState<PromotionRecord | "nueva" | null>(null);
  const names = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);

  return (
    <div className="mx-auto max-w-5xl p-4 lg:p-8">
      <PageHeader
        title="Promociones"
        subtitle="Se aplican solas al vender, cuando corresponde"
        actions={<Button variant="primary" onClick={() => setEditing("nueva")}><Plus className="size-5" /> Nueva promoción</Button>}
      />
      {promotions.length === 0 ? (
        <Card><EmptyState icon={<BadgePercent />} title="Todavía no hay promociones">Por ejemplo: 2×1 en alfajores, combo gaseosa + alfajor, o 10% en golosinas los martes.</EmptyState></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {promotions.map((p) => {
            const live = isPromotionActive(p, now);
            const included = p.kind === "combo" ? (p.comboItems ?? []).map((i) => `${i.quantity} × ${names.get(i.productId) ?? "?"}`) : [...p.productIds.map((id) => names.get(id) ?? "?"), ...(p.categories ?? []).map((c) => `Categoría ${c}`)];
            return (
              <div key={p.id} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => setEditing(p)} className="text-left">
                    <p className="text-xl font-bold">{p.name}</p>
                    <p className="font-semibold text-brand">{describePromotion(p, formatMoney)}</p>
                  </button>
                  <span className={cx("shrink-0 rounded-lg px-2.5 py-1 text-sm font-semibold", live ? "bg-brand-soft text-ink" : "bg-surface-2 text-muted")}>
                    {live ? "Activa ahora" : p.active ? "Fuera de horario" : "Pausada"}
                  </span>
                </div>
                <p className="text-muted">{included.slice(0, 3).join(", ")}{included.length > 3 ? ` y ${included.length - 3} más` : ""}</p>
                <p className="text-sm text-muted">{scheduleText(p.schedule)}</p>
                <Toggle checked={p.active} onChange={(on) => void setPromotionActive(p.id, on)} label={p.active ? "Activada" : "Pausada"} />
              </div>
            );
          })}
        </div>
      )}
      <PromotionEditor promotion={editing === "nueva" ? null : editing} open={editing !== null} products={products} onClose={() => setEditing(null)} />
    </div>
  );
}

const EMPTY: PromotionInput = { name: "", kind: "nxm", active: true, productIds: [], categories: [], buy: 2, pay: 1, comboItems: [], comboPrice: undefined, percent: 10, schedule: undefined };

function PromotionEditor({ promotion, open, products, onClose }: { promotion: PromotionRecord | null; open: boolean; products: Product[]; onClose: () => void }) {
  const [d, setD] = useState<PromotionInput>(EMPTY);
  const [withSchedule, setWithSchedule] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { categories } = catalogOptions(products);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  useEffect(() => {
    if (!open) return;
    const { id: _id, createdAt: _c, updatedAt: _u, _dirty, _df, _rev, deleted: _del, ...rest } = promotion ?? ({ ...EMPTY } as PromotionRecord);
    setD({ ...EMPTY, ...rest });
    setWithSchedule(Boolean(promotion?.schedule));
    setError(null);
  }, [open, promotion]);

  const set = <K extends keyof PromotionInput>(k: K, v: PromotionInput[K]) => setD((x) => ({ ...x, [k]: v }));
  const setSchedule = (patch: Partial<PromotionSchedule>) => setD((x) => ({ ...x, schedule: { ...x.schedule, ...patch } }));
  const comboRegular = (d.comboItems ?? []).reduce((s, i) => s + (byId.get(i.productId)?.price ?? 0) * i.quantity, 0);

  const save = async () => {
    if (!d.name.trim()) return setError("Poné un nombre (por ejemplo, “2×1 en alfajores”).");
    if (d.kind === "nxm" && (!d.buy || d.pay === undefined || d.buy <= d.pay || d.pay < 0)) return setError("En “lleve y pague”, lo que lleva tiene que ser más que lo que paga (por ejemplo, lleve 2, pague 1).");
    if (d.kind !== "combo" && !d.productIds.length && !(d.kind === "porcentaje" && d.categories?.length)) return setError("Elegí a qué productos se aplica.");
    if (d.kind === "combo" && ((d.comboItems ?? []).length < 1 || !d.comboPrice)) return setError("Agregá los productos del combo y su precio.");
    if (d.kind === "combo" && d.comboPrice! >= comboRegular) return setError("El precio del combo tiene que ser menor que la suma de sus productos.");
    if (d.kind === "porcentaje" && (!d.percent || d.percent <= 0 || d.percent > 100)) return setError("El porcentaje tiene que estar entre 1 y 100.");
    const schedule = withSchedule && d.schedule && Object.values(d.schedule).some((v) => (Array.isArray(v) ? v.length : v)) ? d.schedule : undefined;
    await savePromotion(promotion?.id ?? null, { ...d, name: d.name.trim(), schedule });
    toast({ tone: "ok", message: `Guardaste “${d.name.trim()}”` });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={promotion ? "Editar promoción" : "Nueva promoción"} wide footer={
      <>
        {promotion && (
          <Button variant="ghost" className="mr-auto" onClick={async () => { await deletePromotion(promotion.id); onClose(); }}>
            <Trash2 className="size-5" /> Eliminar
          </Button>
        )}
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={save}>Guardar</Button>
      </>
    }>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Nombre (sale en el ticket)"><TextInput value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Ej.: 2×1 en alfajores" /></Field>
        <Field label="Tipo" group>
          <Segmented<PromotionKind> label="Tipo de promoción" value={d.kind} onChange={(kind) => set("kind", kind)}
            options={[{ value: "nxm", label: "Lleve y pague (2×1, 3×2)" }, { value: "combo", label: "Combo a precio fijo" }, { value: "porcentaje", label: "Descuento %" }]} />
        </Field>

        {d.kind === "nxm" && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Lleva"><TextInput inputMode="numeric" className="w-24!" value={String(d.buy ?? "")} onChange={(e) => set("buy", Number(e.target.value.replace(/\D/g, "")) || undefined)} /></Field>
              <Field label="Paga"><TextInput inputMode="numeric" className="w-24!" value={String(d.pay ?? "")} onChange={(e) => set("pay", Number(e.target.value.replace(/\D/g, "")))} /></Field>
              <p className="pb-3 text-muted">Se bonifican las unidades más baratas de cada grupo. Se pueden mezclar los productos elegidos (por ejemplo, alfajores de distintos sabores).</p>
            </div>
            <ProductPicker label="Productos incluidos" products={products} selected={d.productIds} onChange={(ids) => set("productIds", ids)} />
          </>
        )}

        {d.kind === "combo" && (
          <>
            <ComboItems products={products} items={d.comboItems ?? []} onChange={(items) => set("comboItems", items)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Precio del combo" hint={comboRegular ? `Por separado: ${formatMoney(comboRegular)}${d.comboPrice && d.comboPrice < comboRegular ? ` · ahorra ${formatMoney(comboRegular - d.comboPrice)}` : ""}` : undefined}>
                <MoneyInput value={d.comboPrice ?? null} onChange={(v) => set("comboPrice", v ?? undefined)} className="text-xl font-bold" />
              </Field>
            </div>
          </>
        )}

        {d.kind === "porcentaje" && (
          <>
            <Field label="Porcentaje de descuento">
              <TextInput inputMode="decimal" className="w-32!" value={String(d.percent ?? "")} onChange={(e) => set("percent", Number(e.target.value.replace(",", ".")) || undefined)} />
            </Field>
            {categories.length > 0 && (
              <Field label="Categorías completas" group>
                <div className="flex flex-wrap gap-2">
                  {categories.map((c) => {
                    const on = d.categories?.includes(c) ?? false;
                    return (
                      <button key={c} type="button" aria-pressed={on} onClick={() => set("categories", on ? (d.categories ?? []).filter((x) => x !== c) : [...(d.categories ?? []), c])}
                        className={cx("min-h-11 rounded-xl border px-4 font-semibold", on ? "border-brand bg-brand-soft ring-2 ring-brand/40" : "border-line")}>
                        {c}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            <ProductPicker label="Y/o productos sueltos" products={products} selected={d.productIds} onChange={(ids) => set("productIds", ids)} />
          </>
        )}

        <Toggle checked={withSchedule} onChange={setWithSchedule} label="Solo algunos días u horarios" hint="Por ejemplo: los martes, o de 18 a 20 h, o hasta fin de mes." />
        {withSchedule && (
          <div className="grid gap-4 rounded-2xl bg-surface-2 p-4 sm:grid-cols-2">
            <Field label="Desde (fecha)"><TextInput type="date" value={d.schedule?.from ?? ""} onChange={(e) => setSchedule({ from: e.target.value || undefined })} /></Field>
            <Field label="Hasta (fecha)"><TextInput type="date" value={d.schedule?.to ?? ""} onChange={(e) => setSchedule({ to: e.target.value || undefined })} /></Field>
            <div className="sm:col-span-2">
              <Field label="Días (ninguno = todos)" group>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((label, day) => {
                    const on = d.schedule?.weekdays?.includes(day) ?? false;
                    return (
                      <button key={label} type="button" aria-pressed={on}
                        onClick={() => setSchedule({ weekdays: on ? (d.schedule?.weekdays ?? []).filter((x) => x !== day) : [...(d.schedule?.weekdays ?? []), day].sort() })}
                        className={cx("min-h-12 min-w-14 rounded-xl border font-semibold", on ? "border-brand bg-brand-soft ring-2 ring-brand/40" : "border-line bg-surface")}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              </Field>
            </div>
            <Field label="Desde (hora)"><TextInput type="time" value={d.schedule?.fromTime ?? ""} onChange={(e) => setSchedule({ fromTime: e.target.value || undefined })} /></Field>
            <Field label="Hasta (hora)"><TextInput type="time" value={d.schedule?.toTime ?? ""} onChange={(e) => setSchedule({ toTime: e.target.value || undefined })} /></Field>
          </div>
        )}
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ProductSearch({ products, onPick, exclude = [] }: { products: Product[]; onPick: (p: Product) => void; exclude?: string[] }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => (query.trim() ? searchProducts(products, query, 6).filter((p) => !exclude.includes(p.id)) : []), [products, query, exclude]);
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" />
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar producto para agregar" aria-label="Buscar producto para agregar" className={cx(inputClass, "pl-11")} />
      {results.length > 0 && (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => { onPick(p); setQuery(""); }} className="flex w-full justify-between px-4 py-2.5 text-left hover:bg-brand-soft">
                <span>{p.name}</span><span className="num text-muted">{formatMoney(p.price)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductPicker({ label, products, selected, onChange }: { label: string; products: Product[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const names = new Map(products.map((p) => [p.id, p.name]));
  return (
    <Field label={label} group>
      <ProductSearch products={products} exclude={selected} onPick={(p) => onChange([...selected, p.id])} />
      {selected.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {selected.map((id) => (
            <li key={id} className="flex items-center gap-1 rounded-lg bg-surface-2 py-1 pl-3 pr-1">
              {names.get(id) ?? "Producto archivado"}
              <button type="button" onClick={() => onChange(selected.filter((x) => x !== id))} className="rounded p-1 text-muted hover:text-danger" aria-label={`Quitar ${names.get(id)}`}><X className="size-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

function ComboItems({ products, items, onChange }: { products: Product[]; items: { productId: string; quantity: number }[]; onChange: (items: { productId: string; quantity: number }[]) => void }) {
  const byId = new Map(products.map((p) => [p.id, p]));
  return (
    <Field label="Productos del combo" group>
      <ProductSearch products={products} exclude={items.map((i) => i.productId)} onPick={(p) => onChange([...items, { productId: p.id, quantity: 1 }])} />
      {items.length > 0 && (
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
          {items.map((item, i) => (
            <li key={item.productId} className="flex items-center gap-3 px-4 py-2">
              <span className="flex-1">{byId.get(item.productId)?.name ?? "Producto archivado"} <span className="num text-muted">· {formatMoney((byId.get(item.productId)?.price ?? 0) as Cents)}</span></span>
              <TextInput inputMode="numeric" aria-label="Cantidad" className="w-20! text-center" value={String(item.quantity)}
                onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1) } : x)))} />
              <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Quitar"><Trash2 className="size-5" /></button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}
