import { useEffect, useState } from "react";
import { Archive, X } from "lucide-react";
import { formatMoney, IVA_RATES, markupPercent, type Cents } from "@misventas/core";
import { useSettings } from "../data/settings";
import type { Product, Supplier } from "../db";
import { findOrCreateSupplier } from "../data/suppliers";
import { adjustStockTo, archiveProduct, catalogOptions, createProduct, recordLoss, updateProduct, type ProductInput } from "../data/products";
import { Button, Field, inputClass, MoneyInput, Modal, StockBadge, TextInput, Toggle, useToast } from "./ui";

interface Draft {
  name: string;
  price: Cents | null;
  cost: Cents | null;
  barcodes: string[];
  barcodeText: string;
  code: string;
  category: string;
  supplier: string;
  initialStock: string;
  minStock: string;
  favorite: boolean;
  trackStock: boolean;
  ivaRate: number;
}

const fromProduct = (p: Product | null, suppliers: Supplier[], barcode?: string): Draft => ({
  name: p?.name ?? "",
  price: p?.price ?? null,
  cost: p?.cost ?? null,
  barcodes: p?.barcodes ?? (barcode ? [barcode] : []),
  barcodeText: "",
  code: p?.code ?? "",
  category: p?.category ?? "",
  supplier: (p?.supplierId && suppliers.find((s) => s.id === p.supplierId)?.name) || "",
  initialStock: "",
  minStock: String(p?.minStock ?? 0),
  favorite: p?.favorite ?? false,
  trackStock: p?.trackStock ?? true,
  ivaRate: p?.ivaRate ?? 21,
});

const toInt = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export function ProductForm({
  open, product, products, suppliers, prefillBarcode, onClose, onSaved,
}: {
  open: boolean;
  /** null = producto nuevo. */
  product: Product | null;
  products: Product[];
  suppliers: Supplier[];
  prefillBarcode?: string;
  onClose: () => void;
  onSaved?: (p: Product) => void;
}) {
  const [d, setD] = useState<Draft>(() => fromProduct(product, suppliers, prefillBarcode));
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { categories } = catalogOptions(products);
  const settings = useSettings();
  const showIva = settings?.fiscalCondition === "responsable_inscripto";

  useEffect(() => {
    if (open) {
      setD(fromProduct(product, suppliers, prefillBarcode));
      setError(null);
    }
    // Solo al abrir o cambiar de producto: el producto llega "en vivo" y no debe pisar lo que se está editando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product?.id, prefillBarcode]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const addBarcode = () => {
    const code = d.barcodeText.trim();
    if (!code) return;
    setD((x) => ({ ...x, barcodes: x.barcodes.includes(code) ? x.barcodes : [...x.barcodes, code], barcodeText: "" }));
  };

  const markup = d.price !== null ? markupPercent(d.cost, d.price) : null;

  const save = async () => {
    const barcodes = d.barcodeText.trim() ? [...new Set([...d.barcodes, d.barcodeText.trim()])] : d.barcodes;
    if (!d.name.trim()) return setError("Poné un nombre al producto.");
    if (d.price === null || d.price <= 0) return setError("Poné el precio de venta.");
    const taken = products.find((p) => p.id !== product?.id && p.barcodes.some((b) => barcodes.includes(b)));
    if (taken) return setError(`Ese código de barras ya es de "${taken.name}".`);
    const input: ProductInput = {
      name: d.name.trim(),
      price: d.price,
      cost: d.cost,
      barcodes,
      code: d.code.trim() || undefined,
      category: d.category.trim(),
      supplierId: await findOrCreateSupplier(d.supplier),
      minStock: toInt(d.minStock),
      favorite: d.favorite,
      trackStock: d.trackStock,
      ivaRate: d.ivaRate,
    };
    if (product) {
      await updateProduct(product.id, input);
      onSaved?.({ ...product, ...input });
      toast({ tone: "ok", message: `Guardaste ${input.name}` });
    } else {
      const created = await createProduct(input, d.trackStock ? toInt(d.initialStock) : 0);
      onSaved?.(created);
      toast({ tone: "ok", message: `Agregaste ${input.name}` });
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={product ? "Editar producto" : "Nuevo producto"}
      wide
      footer={
        <>
          {product && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={async () => {
                await archiveProduct(product.id);
                toast({ tone: "ok", message: `Archivaste ${product.name}. Ya no aparece para vender.` });
                onClose();
              }}
            >
              <Archive className="size-5" /> Archivar
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={save}>Guardar</Button>
        </>
      }
    >
      <form className="grid gap-5 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="sm:col-span-2">
          <Field label="Nombre">
            <TextInput value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Ej.: Alfajor triple chocolate" />
          </Field>
        </div>
        <Field label="Precio de venta">
          <MoneyInput value={d.price} onChange={(v) => set("price", v)} placeholder="0" className="text-2xl font-bold" />
        </Field>
        <Field
          label="Costo (opcional)"
          hint={markup !== null && d.price !== null && d.cost !== null ? `Ganás ${formatMoney(d.price - d.cost)} por unidad (${Math.round(markup)}%)` : "Sirve para calcular tu ganancia."}
        >
          <MoneyInput value={d.cost} onChange={(v) => set("cost", v)} placeholder="0" />
        </Field>

        <div className="sm:col-span-2">
          <Field label="Código de barras" hint="Escanealo con el lector o tipealo. Un producto puede tener varios.">
            <TextInput
              value={d.barcodeText}
              onChange={(e) => set("barcodeText", e.target.value)}
              onKeyDown={(e) => {
                // El lector manda Enter al final: agrega el código en vez de guardar.
                if (e.key === "Enter") { e.preventDefault(); addBarcode(); }
              }}
              onBlur={addBarcode}
              placeholder="Escaneá acá"
              inputMode="numeric"
            />
          </Field>
          {d.barcodes.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {d.barcodes.map((b) => (
                <li key={b} className="num flex items-center gap-1 rounded-lg bg-surface-2 py-1 pl-3 pr-1">
                  {b}
                  <button type="button" onClick={() => set("barcodes", d.barcodes.filter((x) => x !== b))} className="rounded p-1 text-muted hover:text-danger" aria-label={`Quitar código ${b}`}>
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Field label="Categoría">
          <TextInput value={d.category} onChange={(e) => set("category", e.target.value)} list="categorias" placeholder="Ej.: Bebidas" />
          <datalist id="categorias">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Proveedor">
          <TextInput value={d.supplier} onChange={(e) => set("supplier", e.target.value)} list="proveedores" placeholder="Ej.: Distribuidora Norte" />
          <datalist id="proveedores">{suppliers.map((s) => <option key={s.id} value={s.name} />)}</datalist>
        </Field>
        {showIva && (
          <Field label="Alícuota de IVA" hint="Para discriminar el IVA en las facturas. La mayoría de lo que vende un kiosco es 21%.">
            <select className={inputClass} value={d.ivaRate} onChange={(e) => set("ivaRate", Number(e.target.value))}>
              {IVA_RATES.map((r) => <option key={r} value={r}>{String(r).replace(".", ",")}%</option>)}
            </select>
          </Field>
        )}
        <Field label="Código interno (opcional)" hint="Un número corto para buscarlo rápido.">
          <TextInput value={d.code} onChange={(e) => set("code", e.target.value)} />
        </Field>
        <Field label="Avisarme cuando queden" hint="Aparece en “Me faltan” con esa cantidad o menos.">
          <TextInput inputMode="numeric" value={d.minStock} onChange={(e) => set("minStock", e.target.value)} />
        </Field>
        {!product && d.trackStock && (
          <Field label="¿Cuántos tenés ahora?">
            <TextInput inputMode="numeric" value={d.initialStock} onChange={(e) => set("initialStock", e.target.value)} placeholder="0" />
          </Field>
        )}

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Toggle checked={d.favorite} onChange={(v) => set("favorite", v)} label="Mostrar en favoritos" hint="Aparece como botón en la pantalla de venta." />
          <Toggle checked={d.trackStock} onChange={(v) => set("trackStock", v)} label="Controlar stock" hint="Apagalo para cosas que no se cuentan, como un café o una carga virtual." />
        </div>

        {product && product.trackStock && <StockActions product={product} />}

        {error && <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger sm:col-span-2">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function StockActions({ product }: { product: Product }) {
  const [counted, setCounted] = useState("");
  const [loss, setLoss] = useState("");
  const toast = useToast();
  return (
    <div className="rounded-2xl bg-surface-2 p-4 sm:col-span-2">
      <p className="mb-3 flex items-center gap-3 font-semibold">
        Stock actual <StockBadge stock={product.stock} minStock={product.minStock} trackStock />
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-end gap-2">
          <Field label="Conté y hay">
            <TextInput inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder={String(product.stock)} />
          </Field>
          <Button
            disabled={counted === ""}
            onClick={async () => {
              await adjustStockTo(product.id, toInt(counted), "Conteo");
              toast({ tone: "ok", message: `Stock de ${product.name} corregido a ${toInt(counted)}` });
              setCounted("");
            }}
          >
            Corregir
          </Button>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Se rompió o venció">
            <TextInput inputMode="numeric" value={loss} onChange={(e) => setLoss(e.target.value)} placeholder="0" />
          </Field>
          <Button
            disabled={toInt(loss) <= 0}
            onClick={async () => {
              await recordLoss(product.id, toInt(loss), "Rotura o vencido");
              toast({ tone: "ok", message: `Descontaste ${toInt(loss)} de ${product.name}` });
              setLoss("");
            }}
          >
            Descontar
          </Button>
        </div>
      </div>
    </div>
  );
}
