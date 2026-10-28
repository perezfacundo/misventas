import { describe, expect, it } from "vitest";
import { pesos } from "@misventas/core";
import { CMD, columnsFor, drawerBytes, encodeText, ticketBytes, twoColumns, wrap } from "../src/print/escpos";
import type { Sale, Settings } from "../src/db";

/** Decodifica los renglones de texto de un ticket (ignora los comandos ESC/GS). */
function textLines(bytes: Uint8Array): string[] {
  const reverse = new Map<number, string>([[0xa0, "á"], [0x82, "é"], [0xa1, "í"], [0xa2, "ó"], [0xa3, "ú"], [0xa4, "ñ"], [0xa5, "Ñ"], [0xa7, "º"], [0xb5, "Á"]]);
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x1b || b === 0x1d) {
      // Saltea el comando y sus parámetros.
      const op = bytes[i + 1];
      i += op === 0x70 ? 4 : op === 0x56 ? 3 : 2;
      continue;
    }
    if (b === 0x0a) {
      lines.push(current);
      current = "";
    } else current += b < 0x80 ? String.fromCharCode(b) : reverse.get(b) ?? "?";
  }
  return lines;
}

const includes = (haystack: Uint8Array, needle: readonly number[]) =>
  haystack.some((_, i) => needle.every((n, j) => haystack[i + j] === n));

const settings = {
  businessName: "Kiosco Doña Rosa", address: "Av. Siempreviva 742", taxId: "20-12345678-9", ticketFooter: "¡Gracias por tu compra!",
  paperWidth: 58, enabledMethods: [], priceRounding: 0, devicePrefix: "D01", textSize: "normal", theme: "auto", autoPrint: false,
  printer: { mode: "sistema", name: "POS58", host: "", openDrawer: true }, onboarded: true,
} as Settings;

const sale = {
  id: "s1", number: "D01-000042", createdAt: new Date(2026, 9, 27, 14, 30).getTime(), deviceId: "d", cashSessionId: "c", userId: "u", cashier: "Ana",
  items: [
    { lineId: "1", productId: "p1", name: "Gaseosa cola 500 ml", unitPrice: pesos(1500), unitCost: null, quantity: 2 },
    { lineId: "2", productId: "p2", name: "Alfajor triple de chocolate con dulce de leche extra", unitPrice: pesos(1300), unitCost: null, quantity: 1 },
  ],
  subtotal: pesos(4300), discount: pesos(300), total: pesos(4000),
  payments: [{ method: "efectivo", amount: pesos(4000), tendered: pesos(5000) }], change: pesos(1000), status: "completada",
} as Sale;

describe("texto para la ticketera", () => {
  it("codifica ñ y acentos en PC850", () => {
    expect(encodeText("Año ñandú")).toEqual([0x41, 0xa4, 0x6f, 0x20, 0xa4, 0x61, 0x6e, 0x64, 0xa3]);
  });
  it("translitera lo que no existe en la página de códigos", () => {
    expect(String.fromCharCode(...encodeText("Promo — 2×1…"))).toBe("Promo - 2\u009e1...");
    expect(encodeText("ℵ")).toEqual([0x3f]);
  });
  it("alinea montos a la derecha y corta lo que no entra", () => {
    expect(twoColumns("TOTAL", "$ 4.000", 20)).toBe("TOTAL        $ 4.000");
    expect(twoColumns("Un nombre larguísimo de producto", "$ 9", 16)).toHaveLength(16);
  });
  it("parte los nombres largos por palabras", () => {
    expect(wrap("Alfajor triple de chocolate", 12)).toEqual(["Alfajor", "triple de", "chocolate"]);
    expect(wrap("Supercalifragilístico", 8)).toEqual(["Supercal", "ifragilí", "stico"]);
  });
  it("32 columnas en 58 mm y 48 en 80 mm", () => {
    expect(columnsFor(58)).toBe(32);
    expect(columnsFor(80)).toBe(48);
  });
});

describe("ticket", () => {
  const bytes = ticketBytes(sale, settings, { openDrawer: true });
  const lines = textLines(bytes);

  it("empieza inicializando la impresora con la página de códigos y abre el cajón", () => {
    expect([...bytes.slice(0, 5)]).toEqual([...CMD.init, ...CMD.codepage850]);
    expect(includes(bytes, CMD.drawer)).toBe(true);
  });
  it("termina avanzando papel y cortando", () => {
    expect([...bytes.slice(-7)]).toEqual([...CMD.feed(4), ...CMD.cut]);
  });
  it("tiene los datos del comprobante, ítems, total, pago y vuelto en 32 columnas", () => {
    expect(lines).toContain("Comprobante N.º D01-000042");
    expect(lines).toContain("NO VÁLIDO COMO FACTURA");
    expect(lines).toContain(twoColumns("  2 x $ 1.500", "$ 3.000", 32));
    expect(lines).toContain(twoColumns("Descuento", "-$ 300", 32));
    expect(lines).toContain(twoColumns("TOTAL", "$ 4.000", 32));
    expect(lines).toContain(twoColumns("Efectivo", "$ 5.000", 32));
    expect(lines).toContain(twoColumns("Vuelto", "$ 1.000", 32));
    expect(lines.every((l) => l.length <= 32)).toBe(true);
  });
  it("sin efectivo no abre el cajón", () => {
    expect(includes(ticketBytes(sale, settings), CMD.drawer)).toBe(false);
  });
  it("en 80 mm usa 48 columnas", () => {
    const wide = textLines(ticketBytes(sale, { ...settings, paperWidth: 80 }));
    expect(wide).toContain(twoColumns("TOTAL", "$ 4.000", 48));
  });
  it("abrir el cajón solo", () => {
    expect([...drawerBytes()]).toEqual([...CMD.init, ...CMD.drawer]);
  });
});
