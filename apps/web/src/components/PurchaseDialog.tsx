import { useEffect, useMemo, useState } from "react";
import { PackagePlus, Search, Trash2 } from "lucide-react";
import { findByCode, formatMoney, searchProducts, type Cents } from "@misventas/core";
import type { Product, Supplier } from "../db";
import { registerPurchase } from "../data/suppliers";
import { Button, cx, EmptyState, Field, inputClass, MoneyInput, Modal, TextInput, Toggle, useToast } from "./ui";
import { useSession } from "./Session";

interface Line {
  product: Product;
  quantity: string;
  cost: Cents | null;
}

/** Ingreso de mercadería: se escanea cada producto que llegó y se suma al stock. */
export function PurchaseDialog({
  open, products, suppliers, defaultSupplierId, onClose, onUnknownCode,
}: {
  open: boolean;
  products: Product[];
  suppliers: Supplier[];
  defaultSupplierId?: string | null;
  onClose: () => void;
  onUnknownCode: (code: string) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [unknown, setUnknown] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState<string>("");
  const [paidFromCash, setPaidFromCash] = useState(false);
  const toast = useToast();
  const { user, can } = useSession();
  const results = useMemo(() => searchProducts(products, query, 6), [products, query]);

  useEffect(() => {
    if (open) {
      setLines([]);
      setQuery("");
      setUnknown(null);
      setSupplierId(defaultSupplierId ?? "");
      setPaidFromCash(false);
    }
  }, [open, defaultSupplierId]);

  const add = (p: Product) => {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product.id === p.id);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l));
      return [{ product: p, quantity: "1", cost: p.cost }, ...ls];
    });
    if (!supplierId && p.supplierId) setSupplierId(p.supplierId);
    setQuery("");
    setUnknown(null);
  };

  const submit = () => {
    const p = findByCode(products, query) ?? results[0];
    if (p) add(p);
    else if (query.trim()) setUnknown(query.trim());
  };

  const valid = lines.filter((l) => Number(l.quantity) > 0);
  const total = valid.reduce((s, l) => s + (l.cost ?? 0) * Math.round(Number(l.quantity)), 0);

  const confirm = async () => {
    if (!valid.length) return;
    try {
      await registerPurchase({
        supplierId: supplierId || null,
        paidFromCash,
        userName: user.name,
        lines: valid.map((l) => ({
          productId: l.product.id,
          name: l.product.name,
          quantity: Math.round(Number(l.quantity)),
          cost: l.cost,
          costChanged: l.cost !== l.product.cost,
        })),
      });
      const units = valid.reduce((s, l) => s + Math.round(Number(l.quantity)), 0);
      toast({ tone: "ok", message: `Ingresaste ${units} unidades de ${valid.length} productos` });
      onClose();
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : "No se pudo registrar." });
    }
  };

  const showCosts = can("verCostos");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ingreso de mercadería"
      wide
      footer={
        <>
          {showCosts && total > 0 && <p className="num mr-auto text-lg">Total <b>{formatMoney(total)}</b></p>}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={confirm} disabled={!valid.length}>Sumar al stock</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Proveedor">
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={inputClass}>
              <option value="">Sin proveedor</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          {showCosts && (
            <div className="self-end">
              <Toggle checked={paidFromCash} onChange={setPaidFromCash} label="Lo pagué con plata de la caja" hint="Se registra como retiro de efectivo." />
            </div>
          )}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setUnknown(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            placeholder="Escaneá o buscá lo que llegó"
            aria-label="Buscar producto"
            className={cx(inputClass, "pl-11")}
          />
          {query && results.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              {results.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => add(p)} className="w-full px-4 py-2.5 text-left text-lg hover:bg-brand-soft">{p.name}</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {unknown && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warn-soft px-4 py-3">
            <span className="font-semibold text-warn">No hay ningún producto con el código {unknown}.</span>
            {can("editarProductos") && <Button onClick={() => onUnknownCode(unknown)}>Crear producto</Button>}
          </div>
        )}

        {lines.length === 0 ? (
          <EmptyState icon={<PackagePlus />} title="Todavía no agregaste nada">Escaneá cada producto que trajo el proveedor.</EmptyState>
        ) : (
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th className="py-2 font-semibold">Producto</th>
                <th className="w-24 py-2 font-semibold">Cantidad</th>
                {showCosts && <th className="w-40 py-2 font-semibold">Costo unitario</th>}
                <th className="w-12"><span className="sr-only">Quitar</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {lines.map((l, i) => (
                <tr key={l.product.id}>
                  <td className="py-2 pr-2 text-lg font-semibold">{l.product.name}</td>
                  <td className="py-2 pr-2">
                    <TextInput inputMode="numeric" value={l.quantity} aria-label={`Cantidad de ${l.product.name}`}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                  </td>
                  {showCosts && (
                    <td className="py-2 pr-2">
                      <MoneyInput value={l.cost} aria-label={`Costo de ${l.product.name}`}
                        onChange={(cost) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, cost } : x)))} />
                    </td>
                  )}
                  <td>
                    <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="rounded-lg p-2 text-muted hover:text-danger" aria-label={`Quitar ${l.product.name}`}>
                      <Trash2 className="size-5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
