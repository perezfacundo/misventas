import { parseMoney } from "@misventas/core";
import type { Product, Supplier } from "../db";
import type { ProductInput } from "./products";

/** Columnas de la planilla de productos, en el orden en que se exportan. */
export const CSV_COLUMNS = ["nombre", "codigo_barras", "codigo", "categoria", "proveedor", "costo", "precio", "stock", "stock_minimo"] as const;

function detectDelimiter(headerLine: string): string {
  return (headerLine.match(/;/g)?.length ?? 0) > (headerLine.match(/,/g)?.length ?? 0) ? ";" : ",";
}

/** Parser CSV mínimo con soporte de comillas, para planillas exportadas desde Excel o Google Sheets. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(clean.split(/\r?\n/, 1)[0] ?? "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export interface CsvProductRow {
  input: Omit<ProductInput, "supplierId">;
  /** Nombre del proveedor tal como viene en la planilla (se busca o se crea al importar). */
  supplierName: string;
  stock: number;
}

export interface CsvImportResult {
  rows: CsvProductRow[];
  errors: string[];
}

export function productsFromCsv(text: string): CsvImportResult {
  const [header, ...data] = parseCsv(text);
  if (!header) return { rows: [], errors: ["El archivo está vacío."] };
  const cols = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const idx = (name: string) => cols.indexOf(name);
  if (idx("nombre") < 0 || idx("precio") < 0) {
    return { rows: [], errors: ['La primera fila tiene que tener al menos las columnas "nombre" y "precio".'] };
  }
  const get = (r: string[], name: string) => (idx(name) >= 0 ? (r[idx(name)] ?? "").trim() : "");
  const rows: CsvProductRow[] = [];
  const errors: string[] = [];
  data.forEach((r, i) => {
    const line = i + 2;
    const name = get(r, "nombre");
    const price = parseMoney(get(r, "precio"));
    if (!name) return errors.push(`Fila ${line}: falta el nombre.`);
    if (price === null) return errors.push(`Fila ${line} (${name}): el precio no es válido.`);
    const costText = get(r, "costo");
    const stock = Number(get(r, "stock").replace(",", ".") || 0);
    const minStock = Number(get(r, "stock_minimo").replace(",", ".") || 0);
    rows.push({
      input: {
        name,
        price,
        cost: costText ? parseMoney(costText) : null,
        barcodes: get(r, "codigo_barras").split(/[|\s]+/).filter(Boolean),
        code: get(r, "codigo") || undefined,
        category: get(r, "categoria"),
        minStock: Number.isFinite(minStock) ? minStock : 0,
        trackStock: true,
        favorite: false,
      },
      supplierName: get(r, "proveedor"),
      stock: Number.isFinite(stock) ? stock : 0,
    });
  });
  return { rows, errors };
}

const escapeCsv = (v: string) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const centsToCsv = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2).replace(".", ","));

/** Exporta con ";" y coma decimal, que es lo que Excel en español abre directo. */
export function productsToCsv(products: Product[], suppliers: Supplier[]): string {
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const lines = products.map((p) =>
    [p.name, p.barcodes.join("|"), p.code ?? "", p.category, (p.supplierId && supplierName.get(p.supplierId)) || "", centsToCsv(p.cost), centsToCsv(p.price), String(p.stock), String(p.minStock)]
      .map(escapeCsv)
      .join(";"),
  );
  return "﻿" + [CSV_COLUMNS.join(";"), ...lines].join("\r\n");
}

export function downloadFile(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
