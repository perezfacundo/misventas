import { describe, expect, it } from "vitest";
import {
  applyPercent, expectedCash, findByCode, formatReceiptNumber, markupPercent,
  percentChange, pesos, searchProducts, summarizeSales, uuidv7, type SaleLike,
} from "../src";

describe("precios", () => {
  it("aumento masivo con redondeo a $50", () => {
    expect(applyPercent(pesos(1000), 12, pesos(50))).toBe(pesos(1150));
    expect(applyPercent(pesos(1000), -10)).toBe(pesos(900));
  });
  it("margen sobre costo", () => {
    expect(markupPercent(pesos(800), pesos(1200))).toBe(50);
    expect(markupPercent(null, pesos(1200))).toBeNull();
  });
});

describe("búsqueda", () => {
  const items = [
    { id: "1", name: "Alfajor Guaymallén", barcodes: ["7790001"], code: "A1" },
    { id: "2", name: "Coca-Cola 500ml", barcodes: ["7790895000997"] },
    { id: "3", name: "Agua mineral 500ml", barcodes: [] },
    { id: "4", name: "Galletitas de agua", barcodes: [] },
  ];
  it("ignora acentos y mayúsculas", () => {
    expect(searchProducts(items, "guaymallen").map((i) => i.id)).toEqual(["1"]);
  });
  it("busca por todas las palabras en cualquier orden", () => {
    expect(searchProducts(items, "500 coca").map((i) => i.id)).toEqual(["2"]);
  });
  it("prioriza nombres que empiezan con la búsqueda", () => {
    expect(searchProducts(items, "agua").map((i) => i.id)).toEqual(["3", "4"]);
  });
  it("encuentra por código de barras o código interno", () => {
    expect(findByCode(items, "7790895000997")?.id).toBe("2");
    expect(findByCode(items, "a1")?.id).toBe("1");
    expect(findByCode(items, "999")).toBeUndefined();
  });
});

describe("reportes y caja", () => {
  const sales: SaleLike[] = [
    {
      total: pesos(2400), discount: 0, status: "completada",
      items: [{ lineId: "l", productId: "coca", name: "Coca", unitPrice: pesos(1200), unitCost: pesos(800), quantity: 2 }],
      payments: [{ method: "efectivo", amount: pesos(2400), tendered: pesos(3000) }],
    },
    {
      total: pesos(1000), discount: 0, status: "completada",
      items: [{ lineId: "m", productId: null, name: "Varios", unitPrice: pesos(1000), unitCost: null, quantity: 1 }],
      payments: [{ method: "mercadopago", amount: pesos(1000) }],
    },
    {
      total: pesos(9999), discount: 0, status: "anulada", items: [],
      payments: [{ method: "efectivo", amount: pesos(9999) }],
    },
  ];

  it("resume solo las ventas completadas", () => {
    expect(summarizeSales(sales)).toEqual({
      total: pesos(3400), count: 2, profit: pesos(800),
      byMethod: { efectivo: pesos(2400), mercadopago: pesos(1000) },
    });
  });

  it("efectivo esperado en el cajón", () => {
    const movs = [{ type: "egreso" as const, amount: pesos(500) }, { type: "ingreso" as const, amount: pesos(100) }];
    expect(expectedCash(pesos(5000), sales, movs)).toBe(pesos(7000));
  });

  it("variación porcentual", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(10, 0)).toBeNull();
  });
});

describe("ids", () => {
  it("uuidv7 válido y ordenado por tiempo", () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
  it("número de comprobante con prefijo de dispositivo", () => {
    expect(formatReceiptNumber("D01", 123)).toBe("D01-000123");
  });
});
