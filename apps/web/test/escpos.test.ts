import { describe, expect, it } from "vitest";
import { pesos } from "@misventas/core";
import { CMD, columnsFor, drawerBytes, encodeText, ticketBytes, twoColumns, wrap } from "../src/print/escpos";
import type { Sale, Settings } from "../src/db";

/** Decodifica los renglones de texto de un ticket (ignora los comandos ESC/GS). */
function textLines(bytes: Uint8Array): string[] {
  const reverse = new Map<number, string>([[0xa0, "á"], [0x82, "é"], [0xa1, "í"], [0xa2, "ó"], [0xa3, "ú"], [0xa4, "ñ"], [0xa5, "Ñ"], [0xa7, "º"], [0xb5, "Á"], [0x90, "É"], [0xe0, "Ó"], [0xfa, "·"], [0xad, "¡"]]);
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x1b || b === 0x1d) {
      // Saltea el comando entero según su largo (GS ( k lleva el largo en los dos bytes siguientes).
      const op = bytes[i + 1]!;
      const len =
        b === 0x1d && op === 0x28 ? 5 + bytes[i + 3]! + bytes[i + 4]! * 256
        : b === 0x1b && op === 0x40 ? 2
        : b === 0x1b && op === 0x70 ? 5
        : b === 0x1d && op === 0x56 ? 4
        : 3;
      i += len - 1;
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

describe("factura en la ticketera", () => {
  const issuer = { cuit: "20123456786", razonSocial: "Rosa Pérez", condicion: "monotributo" as const, domicilio: "Av. Siempreviva 742", iibb: "Exento", inicioActividades: "2020-03-01" };
  const base = {
    id: "i1", saleId: "s1", kind: "factura" as const, status: "autorizada" as const, ambiente: "homologacion" as const,
    ptoVta: 3, numero: 12, fecha: "2026-10-28", cae: "70417054367476", caeVto: "2026-11-07",
    receiver: { docTipo: 99, docNro: "0", condicion: 5, name: null }, total: pesos(4000),
    messages: [], associatedId: null, qrUrl: "https://www.arca.gob.ar/fe/qr/?p=eyJ2ZXIiOjF9",
  };
  const facturaC = { ...base, cbteTipo: 11, issuer, amounts: { total: pesos(4000), neto: pesos(4000), iva: 0, groups: [] } };

  it("la C lleva datos del emisor, tipo y número, CAE y QR, y aclara si es de prueba", () => {
    const bytes = ticketBytes(sale, settings, { invoice: facturaC });
    const lines = textLines(bytes);
    expect(lines).toContain("FACTURA C");
    expect(lines).toContain("Cód. 011");
    expect(lines).toContain("N.º 00003-00000012");
    expect(lines).toContain("CUIT 20-12345678-6");
    expect(lines).toContain("PRUEBA - SIN VALIDEZ FISCAL");
    expect(lines).toContain("CAE: 70417054367476");
    expect(lines).toContain("Vto. CAE: 07/11/2026");
    expect(lines).not.toContain("NO VÁLIDO COMO FACTURA");
    expect(includes(bytes, [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00])).toBe(true); // QR modelo 2
    expect(includes(bytes, encodeText(facturaC.qrUrl))).toBe(true);
  });

  it("la B de un responsable inscripto muestra el régimen de transparencia fiscal", () => {
    const facturaB = { ...base, cbteTipo: 6, ambiente: "produccion" as const, issuer: { ...issuer, condicion: "responsable_inscripto" as const },
      amounts: { total: pesos(4000), neto: 330579, iva: 69421, groups: [{ rate: 21 as const, base: 330579, iva: 69421 }] } };
    const lines = textLines(ticketBytes(sale, settings, { invoice: facturaB }));
    expect(lines.join(" ")).toContain("Régimen de Transparencia Fiscal al Consumidor");
    expect(lines).toContain(twoColumns("IVA contenido", "$ 694,21", 32));
    expect(lines).not.toContain("PRUEBA - SIN VALIDEZ FISCAL");
  });

  it("la A discrimina neto e IVA por alícuota y muestra al cliente", () => {
    const facturaA = { ...base, cbteTipo: 1, issuer: { ...issuer, condicion: "responsable_inscripto" as const },
      receiver: { docTipo: 80, docNro: "30712345671", condicion: 1, name: "Proveedor SA" },
      amounts: { total: pesos(4000), neto: 330579, iva: 69421, groups: [{ rate: 21 as const, base: 330579, iva: 69421 }] } };
    const lines = textLines(ticketBytes(sale, settings, { invoice: facturaA }));
    expect(lines).toContain(twoColumns("Neto gravado", "$ 3.305,79", 32));
    expect(lines).toContain(twoColumns("IVA 21%", "$ 694,21", 32));
    expect(lines.join(" ")).toContain("CUIT 30-71234567-1 · Proveedor SA");
  });

  it("la nota de crédito dice qué factura anula", () => {
    const nc = { ...facturaC, id: "n1", kind: "nota_credito" as const, cbteTipo: 13, numero: 1 };
    const lines = textLines(ticketBytes(sale, settings, { invoice: nc, original: facturaC }));
    expect(lines).toContain("NOTA DE CRÉDITO C");
    expect(lines).toContain("Anula Factura C 00003-00000012");
  });
});
