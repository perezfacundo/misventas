import { formatMoney, lineTotal, PAYMENT_LABELS } from "@misventas/core";
import type { Sale, Settings } from "../db";
import { formatDateTime } from "../lib/format";

/**
 * Tickets en ESC/POS, el idioma de las ticketeras térmicas. Se manda el texto tal cual (sin driver gráfico):
 * sale más rápido, más nítido, y permite cortar el papel y abrir el cajón.
 */

// Página de códigos PC850: la más soportada por ticketeras genéricas que tiene ñ y acentos.
const CP850: Record<string, number> = {
  Ç: 0x80, ü: 0x81, é: 0x82, â: 0x83, ä: 0x84, à: 0x85, ç: 0x87, ê: 0x88, ë: 0x89, è: 0x8a, ï: 0x8b, î: 0x8c, ì: 0x8d,
  Ä: 0x8e, É: 0x90, ô: 0x93, ö: 0x94, ò: 0x95, û: 0x96, ù: 0x97, Ö: 0x99, Ü: 0x9a, "×": 0x9e, á: 0xa0, í: 0xa1, ó: 0xa2,
  ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ª: 0xa6, º: 0xa7, "¿": 0xa8, "¡": 0xad, Á: 0xb5, Â: 0xb6, À: 0xb7, ã: 0xc6, Ã: 0xc7,
  Ê: 0xd2, Ë: 0xd3, È: 0xd4, Í: 0xd6, Î: 0xd7, Ï: 0xd8, Ì: 0xde, Ó: 0xe0, Ô: 0xe2, Ò: 0xe3, õ: 0xe4, Õ: 0xe5, Ú: 0xe9,
  Û: 0xea, Ù: 0xeb, "°": 0xf8, "·": 0xfa,
};
const TRANSLITERATE: Record<string, string> = {
  "—": "-", "–": "-", "−": "-", "…": "...", "“": '"', "”": '"', "‘": "'", "’": "'", " ": " ", "€": "EUR", "•": "*",
};

export function encodeText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) out.push(code);
    else if (CP850[ch] !== undefined) out.push(CP850[ch]!);
    else if (TRANSLITERATE[ch] !== undefined) out.push(...encodeText(TRANSLITERATE[ch]!));
    else {
      // Sin equivalente: se prueba sin acento y si no, "?".
      const plain = ch.normalize("NFD").replace(/\p{Diacritic}/gu, "");
      out.push(...(plain !== ch && plain.length === 1 ? encodeText(plain) : [0x3f]));
    }
  }
  return out;
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export const CMD = {
  init: [ESC, 0x40],
  codepage850: [ESC, 0x74, 0x02],
  alignLeft: [ESC, 0x61, 0x00],
  alignCenter: [ESC, 0x61, 0x01],
  boldOn: [ESC, 0x45, 0x01],
  boldOff: [ESC, 0x45, 0x00],
  sizeNormal: [GS, 0x21, 0x00],
  sizeDouble: [GS, 0x21, 0x11],
  sizeTall: [GS, 0x21, 0x01],
  feed: (n: number) => [ESC, 0x64, n],
  /** Corte parcial dejando el papel listo. */
  cut: [GS, 0x56, 0x42, 0x00],
  /** Pulso al cajón de dinero (pin 2), conectado a la ticketera. */
  drawer: [ESC, 0x70, 0x00, 0x19, 0xfa],
} as const;

/** Columnas de texto según el ancho del papel (fuente A). */
export const columnsFor = (paperWidth: 58 | 80) => (paperWidth === 80 ? 48 : 32);

/** Texto a la izquierda y monto a la derecha en una línea; si no entra, el texto se corta. */
export function twoColumns(left: string, right: string, width: number): string {
  const space = width - right.length - 1;
  if (space <= 0) return right.slice(0, width);
  const l = left.length > space ? left.slice(0, space) : left;
  return l + " ".repeat(width - l.length - right.length) + right;
}

/** Corta un texto largo en renglones del ancho del papel, respetando palabras cuando se puede. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
    while (current.length > width) {
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

class Builder {
  private bytes: number[] = [...CMD.init, ...CMD.codepage850];
  raw(cmd: readonly number[]) {
    this.bytes.push(...cmd);
    return this;
  }
  line(text = "") {
    this.bytes.push(...encodeText(text), LF);
    return this;
  }
  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export interface TicketOptions {
  /** Abrir el cajón de dinero (solo tiene sentido si hubo efectivo). */
  openDrawer?: boolean;
}

export function ticketBytes(sale: Sale, settings: Settings, opts: TicketOptions = {}): Uint8Array {
  const width = columnsFor(settings.paperWidth);
  const b = new Builder();
  if (opts.openDrawer) b.raw(CMD.drawer);
  const dashed = "-".repeat(width);

  b.raw(CMD.alignCenter).raw(CMD.boldOn).raw(CMD.sizeDouble);
  for (const l of wrap(settings.businessName || "Mis Ventas", Math.floor(width / 2))) b.line(l);
  b.raw(CMD.sizeNormal).raw(CMD.boldOff);
  if (settings.address) for (const l of wrap(settings.address, width)) b.line(l);
  if (settings.taxId) b.line(`CUIT ${settings.taxId}`);
  b.raw(CMD.alignLeft).line();
  b.line(`Comprobante N.º ${sale.number}`);
  b.line(formatDateTime(sale.createdAt));
  b.line(`Atendió: ${sale.cashier}`);
  b.raw(CMD.boldOn).line("NO VÁLIDO COMO FACTURA").raw(CMD.boldOff);
  b.line(dashed);

  for (const item of sale.items) {
    for (const l of wrap(item.name, width)) b.line(l);
    b.line(twoColumns(`  ${item.quantity} x ${formatMoney(item.unitPrice)}`, formatMoney(lineTotal(item)), width));
  }
  b.line(dashed);
  if (sale.discount > 0) b.line(twoColumns("Descuento", `-${formatMoney(sale.discount)}`, width));

  // Total en doble alto (mismo ancho de columnas) para que se lea de lejos.
  b.raw(CMD.boldOn).raw(CMD.sizeTall).line(twoColumns("TOTAL", formatMoney(sale.total), width)).raw(CMD.sizeNormal).raw(CMD.boldOff);
  for (const p of sale.payments) b.line(twoColumns(PAYMENT_LABELS[p.method], formatMoney(p.tendered ?? p.amount), width));
  if (sale.change > 0) b.line(twoColumns("Vuelto", formatMoney(sale.change), width));
  if (sale.status === "anulada") b.raw(CMD.alignCenter).raw(CMD.boldOn).line("*** ANULADA ***").raw(CMD.boldOff).raw(CMD.alignLeft);

  if (settings.ticketFooter) {
    b.line().raw(CMD.alignCenter);
    for (const l of wrap(settings.ticketFooter, width)) b.line(l);
    b.raw(CMD.alignLeft);
  }
  return b.raw(CMD.feed(4)).raw(CMD.cut).build();
}

/** Solo abrir el cajón (por ejemplo, en una venta en efectivo sin ticket). */
export function drawerBytes(): Uint8Array {
  return Uint8Array.from([...CMD.init, ...CMD.drawer]);
}

/** Ticket de prueba para verificar que la impresora y los acentos andan bien. */
export function testPageBytes(settings: Pick<Settings, "paperWidth" | "businessName">): Uint8Array {
  const width = columnsFor(settings.paperWidth);
  return new Builder()
    .raw(CMD.alignCenter).raw(CMD.boldOn).raw(CMD.sizeDouble).line("Mis Ventas").raw(CMD.sizeNormal).raw(CMD.boldOff)
    .line("Prueba de impresión")
    .raw(CMD.alignLeft).line("-".repeat(width))
    .line("Acentos: á é í ó ú ñ Ñ ü ¿? ¡!")
    .line(twoColumns("Alfajor triple", "$ 1.300", width))
    .line("1234567890".repeat(5).slice(0, width))
    .line("-".repeat(width))
    .raw(CMD.alignCenter).line(settings.businessName || "")
    .raw(CMD.feed(4)).raw(CMD.cut)
    .build();
}
