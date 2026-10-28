import { useEffect, useMemo, useState } from "react";
import { applyPercent, formatMoney, pesos, type Cents } from "@misventas/core";
import type { Product, Supplier } from "../db";
import { bulkUpdatePrices, catalogOptions } from "../data/products";
import { Button, Field, Modal, Segmented, TextInput, Toggle, inputClass, useToast } from "./ui";

type Scope = "todos" | "categoria" | "proveedor";

/** Aumento masivo de precios: indispensable cuando la lista del proveedor cambia seguido. */
export function PriceUpdateDialog({ open, products, suppliers, defaultRounding, onClose }: {
  open: boolean;
  products: Product[];
  suppliers: Supplier[];
  defaultRounding: Cents;
  onClose: () => void;
}) {
  const { categories } = catalogOptions(products);
  const [scope, setScope] = useState<Scope>("todos");
  const [group, setGroup] = useState("");
  const [percentText, setPercentText] = useState("");
  const [rounding, setRounding] = useState<Cents>(defaultRounding);
  const [alsoCost, setAlsoCost] = useState(true);
  const toast = useToast();

  useEffect(() => {
    if (open) { setScope("todos"); setGroup(""); setPercentText(""); setRounding(defaultRounding); setAlsoCost(true); }
  }, [open, defaultRounding]);

  const percent = Number(percentText.replace(",", "."));
  const valid = percentText !== "" && Number.isFinite(percent) && percent !== 0 && percent > -100;

  const affected = useMemo(
    () => products.filter((p) => scope === "todos" || (scope === "categoria" ? p.category === group : p.supplierId === group)),
    [products, scope, group],
  );
  const changes = valid
    ? affected.map((p) => ({
        product: p,
        price: applyPercent(p.price, percent, rounding),
        cost: alsoCost && p.cost !== null ? applyPercent(p.cost, percent) : p.cost,
      }))
    : [];

  const apply = async () => {
    const previous = changes.map((c) => ({ id: c.product.id, price: c.product.price, cost: c.product.cost }));
    await bulkUpdatePrices(changes.map((c) => ({ id: c.product.id, price: c.price, cost: alsoCost ? c.cost : undefined })));
    toast({
      tone: "ok",
      message: `Actualizaste ${changes.length} precios`,
      action: { label: "Deshacer", run: () => void bulkUpdatePrices(previous) },
    });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Actualizar precios"
      wide
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={apply} disabled={!changes.length}>Actualizar {changes.length || ""} precios</Button></>}
    >
      <div className="flex flex-col gap-5">
        <Field label="¿A qué productos?" group>
          <Segmented<Scope>
            label="Alcance"
            value={scope}
            onChange={(s) => { setScope(s); setGroup(""); }}
            options={[{ value: "todos", label: "Todos" }, { value: "categoria", label: "Una categoría" }, { value: "proveedor", label: "Un proveedor" }]}
          />
        </Field>
        {scope !== "todos" && (
          <Field label={scope === "categoria" ? "Categoría" : "Proveedor"}>
            <select value={group} onChange={(e) => setGroup(e.target.value)} className={inputClass}>
              <option value="">Elegí una…</option>
              {scope === "categoria"
                ? categories.map((g) => <option key={g} value={g}>{g}</option>)
                : suppliers.map((sup) => <option key={sup.id} value={sup.id}>{sup.name}</option>)}
            </select>
          </Field>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Porcentaje de aumento" hint="Para bajar precios, usá un número negativo (ej.: −5).">
            <TextInput inputMode="decimal" value={percentText} onChange={(e) => setPercentText(e.target.value)} placeholder="Ej.: 8" />
          </Field>
          <Field label="Redondear hacia arriba a" group>
            <Segmented<Cents>
              label="Redondeo"
              value={rounding}
              onChange={setRounding}
              options={[{ value: 0, label: "No" }, { value: pesos(10), label: "$10" }, { value: pesos(50), label: "$50" }, { value: pesos(100), label: "$100" }]}
            />
          </Field>
        </div>
        <Toggle checked={alsoCost} onChange={setAlsoCost} label="También subir el costo" hint="Si el aumento viene del proveedor, así tu ganancia sigue bien calculada." />

        {changes.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-semibold text-muted">Así van a quedar ({changes.length})</p>
            <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {changes.slice(0, 100).map((c) => (
                <li key={c.product.id} className="flex items-center justify-between gap-4 px-4 py-2">
                  <span className="truncate">{c.product.name}</span>
                  <span className="num whitespace-nowrap">
                    <span className="text-muted line-through">{formatMoney(c.product.price)}</span> → <b>{formatMoney(c.price)}</b>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
