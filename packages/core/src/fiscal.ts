import type { Cents } from "./money.ts";

/**
 * Factura electrónica de ARCA (WSFEv1): tipos de comprobante, condición frente al IVA, IVA por alícuota y QR.
 * Todo en centavos; los montos a ARCA se mandan con dos decimales.
 */

export type IssuerCondition = "monotributo" | "responsable_inscripto";

export const ISSUER_CONDITION_LABELS: Record<IssuerCondition, string> = {
  monotributo: "Responsable Monotributo",
  responsable_inscripto: "IVA Responsable Inscripto",
};

/** Tipos de comprobante (tabla de ARCA). */
export const CBTE = {
  FACTURA_A: 1,
  NOTA_CREDITO_A: 3,
  FACTURA_B: 6,
  NOTA_CREDITO_B: 8,
  FACTURA_C: 11,
  NOTA_CREDITO_C: 13,
} as const;

export const CBTE_LABELS: Record<number, string> = {
  1: "Factura A",
  3: "Nota de crédito A",
  6: "Factura B",
  8: "Nota de crédito B",
  11: "Factura C",
  13: "Nota de crédito C",
};

export const cbteLetter = (tipo: number) => (tipo <= 5 ? "A" : tipo <= 10 ? "B" : "C");

/** Tipos de documento del receptor. */
export const DOC = { CUIT: 80, CUIL: 86, DNI: 96, CONSUMIDOR_FINAL: 99 } as const;

export const DOC_LABELS: Record<number, string> = { 80: "CUIT", 86: "CUIL", 96: "DNI", 99: "Consumidor final" };

/**
 * Condición frente al IVA del receptor (CondicionIVAReceptorId, obligatoria en WSFEv1).
 * Las que puede usar un kiosco; la lista completa la devuelve FEParamGetCondicionIvaReceptor.
 */
export const RECEIVER_CONDITIONS = {
  RESPONSABLE_INSCRIPTO: 1,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  MONOTRIBUTO: 6,
  NO_CATEGORIZADO: 7,
  NO_ALCANZADO: 15,
} as const;

export const RECEIVER_CONDITION_LABELS: Record<number, string> = {
  1: "IVA Responsable Inscripto",
  4: "IVA Sujeto Exento",
  5: "Consumidor Final",
  6: "Responsable Monotributo",
  7: "Sujeto No Categorizado",
  15: "IVA No Alcanzado",
};

/** Qué factura corresponde: el monotributista emite C; el responsable inscripto, A a otro inscripto o monotributista, y B al resto. */
export function invoiceTypeFor(issuer: IssuerCondition, receiverCondition: number): number {
  if (issuer === "monotributo") return CBTE.FACTURA_C;
  return receiverCondition === RECEIVER_CONDITIONS.RESPONSABLE_INSCRIPTO || receiverCondition === RECEIVER_CONDITIONS.MONOTRIBUTO
    ? CBTE.FACTURA_A
    : CBTE.FACTURA_B;
}

export function creditNoteTypeFor(invoiceType: number): number {
  const map: Record<number, number> = { 1: 3, 6: 8, 11: 13 };
  const nc = map[invoiceType];
  if (!nc) throw new Error(`No hay nota de crédito para el comprobante ${invoiceType}`);
  return nc;
}

/** La factura A exige CUIT del receptor. */
export const requiresCuit = (invoiceType: number) => cbteLetter(invoiceType) === "A";

// --- IVA ---

/** Alícuotas de IVA y su código en ARCA. */
export const IVA_RATES = [21, 10.5, 27, 5, 2.5, 0] as const;
export type IvaRate = (typeof IVA_RATES)[number];
export const IVA_ID: Record<IvaRate, number> = { 0: 3, 10.5: 4, 21: 5, 27: 6, 5: 8, 2.5: 9 };

export interface TaxableLine {
  /** Importe final de la línea, IVA incluido (precio × cantidad). */
  gross: Cents;
  /** Alícuota del producto; si falta, 21%. */
  ivaRate?: number;
}

export interface IvaGroup {
  rate: IvaRate;
  /** Neto gravado. */
  base: Cents;
  iva: Cents;
}

const toRate = (r: number | undefined): IvaRate => ((IVA_RATES as readonly number[]).includes(r ?? 21) ? (r ?? 21) : 21) as IvaRate;

/**
 * Separa neto e IVA por alícuota a partir de precios finales. El descuento se reparte en proporción.
 * Cada grupo cumple base + iva = bruto exacto (el IVA absorbe el redondeo), así las sumas cierran con ARCA.
 */
export function ivaBreakdown(lines: readonly TaxableLine[], discount: Cents = 0): IvaGroup[] {
  const totals = new Map<IvaRate, Cents>();
  for (const l of lines) totals.set(toRate(l.ivaRate), (totals.get(toRate(l.ivaRate)) ?? 0) + l.gross);
  const gross = [...totals.values()].reduce((s, v) => s + v, 0);
  if (gross <= 0) return [];
  const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  // Reparto del descuento: proporcional, y el redondeo va al grupo más grande.
  let remainingDiscount = Math.min(discount, gross);
  const allocated = entries.map(([rate, g], i) => {
    const share = i === entries.length - 1 ? remainingDiscount : Math.round((discount * g) / gross);
    remainingDiscount -= share;
    return [rate, g - share] as const;
  });
  return allocated
    .filter(([, g]) => g > 0)
    .map(([rate, g]) => {
      const base = Math.round(g / (1 + rate / 100));
      return { rate, base, iva: g - base };
    });
}

export interface InvoiceAmounts {
  total: Cents;
  neto: Cents;
  iva: Cents;
  /** Vacío en facturas C (no se informa el IVA). */
  groups: IvaGroup[];
}

/** Importes a informar. En la C todo es "neto" y no se discrimina IVA. */
export function invoiceAmounts(invoiceType: number, lines: readonly TaxableLine[], discount: Cents = 0): InvoiceAmounts {
  const total = Math.max(0, lines.reduce((s, l) => s + l.gross, 0) - discount);
  if (cbteLetter(invoiceType) === "C") return { total, neto: total, iva: 0, groups: [] };
  const groups = ivaBreakdown(lines, discount);
  const iva = groups.reduce((s, g) => s + g.iva, 0);
  return { total, neto: total - iva, iva, groups };
}

/** Pesos con dos decimales, como los espera ARCA ("1234.50"). */
export const arcaAmount = (cents: Cents) => (cents / 100).toFixed(2);

// --- Documentos ---

/** Verifica el dígito verificador de un CUIT/CUIL. */
export function isValidCuit(value: string): boolean {
  const d = value.replace(/\D/g, "");
  if (d.length !== 11) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((s, w, i) => s + w * Number(d[i]), 0);
  const mod = 11 - (sum % 11);
  const check = mod === 11 ? 0 : mod === 10 ? 9 : mod;
  return check === Number(d[10]);
}

export const formatCuit = (value: string) => {
  const d = value.replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : value;
};

/** "00003-00000123" */
export const formatInvoiceNumber = (ptoVta: number, numero: number) => `${String(ptoVta).padStart(5, "0")}-${String(numero).padStart(8, "0")}`;

/**
 * Desde $10.000.000 (RG 5700/2025) hay que identificar al consumidor final. El umbral es configurable
 * porque cambia por normativa.
 */
export const DEFAULT_IDENTIFICATION_THRESHOLD: Cents = 10_000_000_00;

export const needsIdentification = (total: Cents, threshold: Cents = DEFAULT_IDENTIFICATION_THRESHOLD) => total >= threshold;

// --- QR (RG 4892/2020) ---

export interface QrData {
  fecha: string; // AAAA-MM-DD
  cuit: string;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: Cents;
  docTipo: number;
  docNro: string;
  cae: string;
}

/** URL que va en el QR del comprobante: JSON de la versión 1 codificado en Base64. */
export function invoiceQrUrl(d: QrData): string {
  const json: Record<string, string | number> = {
    ver: 1,
    fecha: d.fecha,
    cuit: Number(d.cuit.replace(/\D/g, "")),
    ptoVta: d.ptoVta,
    tipoCmp: d.tipoCmp,
    nroCmp: d.nroCmp,
    importe: Number(arcaAmount(d.importe)),
    moneda: "PES",
    ctz: 1,
  };
  const docNro = Number(d.docNro.replace(/\D/g, ""));
  if (d.docTipo !== DOC.CONSUMIDOR_FINAL && docNro > 0) {
    json.tipoDocRec = d.docTipo;
    json.nroDocRec = docNro;
  }
  json.tipoCodAut = "E";
  json.codAut = Number(d.cae);
  // btoa existe en el navegador y en Node: el JSON es ASCII (solo números y letras sin acentos).
  return `https://www.arca.gob.ar/fe/qr/?p=${btoa(JSON.stringify(json))}`;
}
