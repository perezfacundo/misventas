import { useMemo, useRef, useState } from "react";
import { Download, PackagePlus, Plus, Search, Star, TrendingUp, Upload } from "lucide-react";
import { formatMoney, searchProducts, stockStatus } from "@misventas/core";
import type { Product, Settings, Supplier } from "../db";
import { findOrCreateSupplier, useSuppliers } from "../data/suppliers";
import { useSession } from "../components/Session";
import { catalogOptions, createProduct, updateProduct, useProducts } from "../data/products";
import { downloadFile, productsFromCsv, productsToCsv, type CsvImportResult } from "../data/csv";
import { Button, cx, EmptyState, Modal, PageHeader, StockBadge, inputClass, useToast } from "../components/ui";
import { ProductForm } from "../components/ProductForm";
import { PurchaseDialog } from "../components/PurchaseDialog";
import { PriceUpdateDialog } from "../components/PriceUpdateDialog";
import { formatDate, plural } from "../lib/format";

type Filter = "todos" | "faltan" | "favoritos";

export function Productos({ settings }: { settings: Settings }) {
  const products = useProducts();
  const suppliers = useSuppliers();
  const { can } = useSession();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [category, setCategory] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; barcode?: string } | null>(null);
  const [dialog, setDialog] = useState<null | "ingreso" | "precios">(null);
  const [csv, setCsv] = useState<CsvImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { categories } = catalogOptions(products);

  const missingCount = products.filter((p) => p.trackStock && stockStatus(p.stock, p.minStock) !== "ok").length;

  const visible = useMemo(() => {
    let list = query.trim() ? searchProducts(products, query, 500) : products;
    if (filter === "faltan") list = list.filter((p) => p.trackStock && stockStatus(p.stock, p.minStock) !== "ok");
    if (filter === "favoritos") list = list.filter((p) => p.favorite);
    if (category) list = list.filter((p) => p.category === category);
    return list;
  }, [products, query, filter, category]);

  const editingProduct = editing?.id ? products.find((p) => p.id === editing.id) ?? null : null;

  const importCsv = async () => {
    if (!csv) return;
    let created = 0;
    let updated = 0;
    for (const row of csv.rows) {
      const existing = products.find((p) =>
        row.input.barcodes.some((b) => p.barcodes.includes(b)) || p.name.toLowerCase() === row.input.name.toLowerCase(),
      );
      if (existing) {
        const supplierId = row.supplierName ? await findOrCreateSupplier(row.supplierName) : existing.supplierId;
        await updateProduct(existing.id, {
          price: row.input.price,
          cost: row.input.cost ?? existing.cost,
          category: row.input.category || existing.category,
          supplierId,
          minStock: row.input.minStock || existing.minStock,
          barcodes: [...new Set([...existing.barcodes, ...row.input.barcodes])],
        });
        updated++;
      } else {
        await createProduct({ ...row.input, supplierId: await findOrCreateSupplier(row.supplierName) }, row.stock);
        created++;
      }
    }
    setCsv(null);
    toast({ tone: "ok", message: `Listo: ${created} productos nuevos y ${updated} actualizados.` });
  };

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader
        title="Productos"
        subtitle={plural(products.length, "producto cargado", "productos cargados")}
        actions={
          <>
            {can("editarProductos") && <Button variant="primary" onClick={() => setEditing({ id: null })}><Plus className="size-5" /> Nuevo producto</Button>}
            {can("ingresarMercaderia") && <Button onClick={() => setDialog("ingreso")}><PackagePlus className="size-5" /> Llegó mercadería</Button>}
            {can("editarProductos") && <Button onClick={() => setDialog("precios")}><TrendingUp className="size-5" /> Actualizar precios</Button>}
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nombre o código" aria-label="Buscar producto" className={cx(inputClass, "pl-11")} />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Categoría" className={cx(inputClass, "sm:w-52")}>
          <option value="">Todas las categorías</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Filtro">
        {([
          ["todos", "Todos"],
          ["faltan", `Me faltan (${missingCount})`],
          ["favoritos", "Favoritos"],
        ] as [Filter, string][]).map(([f, label]) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cx(
              "min-h-11 rounded-full border px-4 font-semibold",
              filter === f ? "border-ink bg-ink text-bg" : "border-line bg-surface hover:bg-surface-2",
              f === "faltan" && missingCount > 0 && filter !== f && "border-warn/50 text-warn",
            )}
          >
            {label}
          </button>
        ))}
        {can("editarProductos") && (
          <span className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => fileRef.current?.click()}><Upload className="size-5" /> Importar planilla</Button>
            <Button variant="ghost" onClick={() => downloadFile(`productos-${formatDate(Date.now()).replace(/\//g, "-")}.csv`, productsToCsv(products, suppliers), "text/csv;charset=utf-8")}>
              <Download className="size-5" /> Exportar
            </Button>
          </span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) setCsv(productsFromCsv(await file.text()));
          }}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        {visible.length === 0 ? (
          <EmptyState icon={<Search />} title={products.length ? "No hay productos que coincidan" : "Todavía no cargaste productos"}>
            {!products.length && "Agregalos de a uno, escaneando, o importá una planilla de Excel."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {visible.map((p) => (
              <ProductRow key={p.id} product={p} suppliers={suppliers} onClick={can("editarProductos") ? () => setEditing({ id: p.id }) : undefined} />
            ))}
          </ul>
        )}
      </div>

      <ProductForm
        open={editing !== null}
        product={editingProduct}
        products={products}
        suppliers={suppliers}
        prefillBarcode={editing?.barcode}
        onClose={() => setEditing(null)}
      />
      <PurchaseDialog
        open={dialog === "ingreso"}
        products={products}
        suppliers={suppliers}
        onClose={() => setDialog(null)}
        onUnknownCode={(code) => { setDialog(null); setEditing({ id: null, barcode: code }); }}
      />
      <PriceUpdateDialog open={dialog === "precios"} products={products} suppliers={suppliers} defaultRounding={settings.priceRounding} onClose={() => setDialog(null)} />

      <Modal
        open={csv !== null}
        onClose={() => setCsv(null)}
        title="Importar planilla"
        footer={<><Button onClick={() => setCsv(null)}>Cancelar</Button><Button variant="primary" onClick={importCsv} disabled={!csv?.rows.length}>Importar {csv?.rows.length} productos</Button></>}
      >
        {csv && (
          <div className="flex flex-col gap-3">
            <p className="text-lg">Encontramos <b>{plural(csv.rows.length, "producto", "productos")}</b>. Los que ya existen (mismo código o nombre) se actualizan; el resto se agrega.</p>
            {csv.errors.length > 0 && (
              <div className="rounded-xl bg-warn-soft px-4 py-3 text-warn">
                <p className="font-semibold">Estas filas no se van a importar:</p>
                <ul className="mt-1 list-disc pl-5">{csv.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul>
              </div>
            )}
            <p className="text-sm text-muted">Columnas: nombre, precio (obligatorias), codigo_barras, codigo, categoria, proveedor, costo, stock, stock_minimo.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ProductRow({ product: p, suppliers, onClick }: { product: Product; suppliers: Supplier[]; onClick?: () => void }) {
  const supplier = p.supplierId ? suppliers.find((s) => s.id === p.supplierId)?.name : undefined;
  return (
    <li>
      <button type="button" onClick={onClick} disabled={!onClick} className="flex w-full items-center gap-4 px-4 py-3.5 text-left enabled:hover:bg-surface-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-lg font-semibold">
            {p.favorite && <Star className="size-4 shrink-0 fill-current text-warn" aria-label="Favorito" />}
            {p.name}
          </p>
          <p className="truncate text-muted">{[p.category, supplier].filter(Boolean).join(" · ") || "Sin categoría"}</p>
        </div>
        <StockBadge stock={p.stock} minStock={p.minStock} trackStock={p.trackStock} />
        <span className="num w-28 text-right text-xl font-bold">{formatMoney(p.price)}</span>
      </button>
    </li>
  );
}
