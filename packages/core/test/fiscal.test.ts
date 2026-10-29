import { describe, expect, it } from "vitest";
import {
  CBTE, creditNoteTypeFor, formatCuit, formatInvoiceNumber, invoiceAmounts, invoiceQrUrl, invoiceTypeFor,
  isValidCuit, ivaBreakdown, needsIdentification, pesos, RECEIVER_CONDITIONS,
} from "../src";

describe("tipo de comprobante", () => {
  it("el monotributista siempre hace C", () => {
    expect(invoiceTypeFor("monotributo", RECEIVER_CONDITIONS.CONSUMIDOR_FINAL)).toBe(CBTE.FACTURA_C);
    expect(invoiceTypeFor("monotributo", RECEIVER_CONDITIONS.RESPONSABLE_INSCRIPTO)).toBe(CBTE.FACTURA_C);
  });
  it("el responsable inscripto hace A a inscriptos y monotributistas, y B al resto", () => {
    expect(invoiceTypeFor("responsable_inscripto", RECEIVER_CONDITIONS.RESPONSABLE_INSCRIPTO)).toBe(CBTE.FACTURA_A);
    expect(invoiceTypeFor("responsable_inscripto", RECEIVER_CONDITIONS.MONOTRIBUTO)).toBe(CBTE.FACTURA_A);
    expect(invoiceTypeFor("responsable_inscripto", RECEIVER_CONDITIONS.CONSUMIDOR_FINAL)).toBe(CBTE.FACTURA_B);
    expect(invoiceTypeFor("responsable_inscripto", RECEIVER_CONDITIONS.EXENTO)).toBe(CBTE.FACTURA_B);
  });
  it("cada factura tiene su nota de crédito", () => {
    expect(creditNoteTypeFor(1)).toBe(3);
    expect(creditNoteTypeFor(6)).toBe(8);
    expect(creditNoteTypeFor(11)).toBe(13);
  });
});

describe("IVA", () => {
  it("separa neto e IVA y la suma cierra exacta", () => {
    const groups = ivaBreakdown([{ gross: pesos(1210) }]);
    expect(groups).toEqual([{ rate: 21, base: pesos(1000), iva: pesos(210) }]);
  });
  it("agrupa por alícuota y reparte el descuento en proporción", () => {
    const groups = ivaBreakdown([
      { gross: pesos(3000), ivaRate: 21 },
      { gross: pesos(1000), ivaRate: 10.5 },
    ], pesos(400));
    const totalGross = groups.reduce((s, g) => s + g.base + g.iva, 0);
    expect(totalGross).toBe(pesos(3600));
    expect(groups.map((g) => g.rate)).toEqual([21, 10.5]);
    expect(groups[0]!.base + groups[0]!.iva).toBe(pesos(2700));
    expect(groups[1]!.base + groups[1]!.iva).toBe(pesos(900));
  });
  it("cierra al centavo con montos raros", () => {
    for (const cents of [1, 99, 12345, 99999, 333333]) {
      const [g] = ivaBreakdown([{ gross: cents }]);
      expect(g!.base + g!.iva).toBe(cents);
    }
  });
  it("la factura C no discrimina IVA", () => {
    expect(invoiceAmounts(CBTE.FACTURA_C, [{ gross: pesos(1210) }])).toEqual({ total: pesos(1210), neto: pesos(1210), iva: 0, groups: [] });
  });
  it("la B informa neto + IVA = total", () => {
    const a = invoiceAmounts(CBTE.FACTURA_B, [{ gross: pesos(1500) }, { gross: pesos(800), ivaRate: 10.5 }], pesos(100));
    expect(a.total).toBe(pesos(2200));
    expect(a.neto + a.iva).toBe(a.total);
  });
});

describe("documentos", () => {
  it("valida el dígito verificador del CUIT", () => {
    expect(isValidCuit("20-12345678-6")).toBe(true);
    expect(isValidCuit("20123456786")).toBe(true);
    expect(isValidCuit("20-12345678-9")).toBe(false);
    expect(isValidCuit("30-71234567-1")).toBe(true);
    expect(isValidCuit("30-71234567-2")).toBe(false);
    expect(isValidCuit("123")).toBe(false);
  });
  it("formatos", () => {
    expect(formatCuit("20123456786")).toBe("20-12345678-6");
    expect(formatInvoiceNumber(3, 123)).toBe("00003-00000123");
  });
  it("umbral de identificación del consumidor final", () => {
    expect(needsIdentification(pesos(9_999_999))).toBe(false);
    expect(needsIdentification(pesos(10_000_000))).toBe(true);
  });
});

describe("QR", () => {
  it("arma la URL con el JSON de ARCA en Base64", () => {
    const url = invoiceQrUrl({ fecha: "2026-10-28", cuit: "20-12345678-6", ptoVta: 3, tipoCmp: 6, nroCmp: 42, importe: pesos(1500.5), docTipo: 99, docNro: "0", cae: "70417054367476" });
    expect(url.startsWith("https://www.arca.gob.ar/fe/qr/?p=")).toBe(true);
    const json = JSON.parse(atob(url.split("?p=")[1]!));
    expect(json).toEqual({ ver: 1, fecha: "2026-10-28", cuit: 20123456786, ptoVta: 3, tipoCmp: 6, nroCmp: 42, importe: 1500.5, moneda: "PES", ctz: 1, tipoCodAut: "E", codAut: 70417054367476 });
  });
  it("incluye el documento del receptor cuando hay", () => {
    const url = invoiceQrUrl({ fecha: "2026-10-28", cuit: "20123456786", ptoVta: 1, tipoCmp: 1, nroCmp: 1, importe: 100, docTipo: 80, docNro: "30-71234567-0", cae: "1" });
    const json = JSON.parse(atob(url.split("?p=")[1]!));
    expect(json).toMatchObject({ tipoDocRec: 80, nroDocRec: 30712345670 });
  });
});
