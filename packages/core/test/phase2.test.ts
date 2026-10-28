import { describe, expect, it } from "vitest";
import {
  balanceOf, can, checkCreditLimit, debtors, pesos, productsWithoutSales, salesByDay,
  salesByGroup, salesByProduct, salesByUser, settle, whatsappLink, whatsappNumber, type ReportSale,
} from "../src";

describe("permisos", () => {
  it("el cajero vende pero no anula ni ve costos", () => {
    expect(can("cajero", "anularVenta")).toBe(false);
    expect(can("cajero", "verCostos")).toBe(false);
    expect(can("cajero", "ingresarMercaderia")).toBe(true);
  });
  it("el encargado no administra usuarios", () => {
    expect(can("encargado", "anularVenta")).toBe(true);
    expect(can("encargado", "usuarios")).toBe(false);
  });
  it("el dueño puede todo; sin usuario, nada", () => {
    expect(can("dueno", "usuarios")).toBe(true);
    expect(can(null, "descontar")).toBe(false);
  });
});

describe("cuenta corriente", () => {
  const day = (n: number) => n * 86_400_000;
  const movs = [
    { customerId: "juan", amount: pesos(3000), createdAt: day(1) },
    { customerId: "juan", amount: pesos(-3000), createdAt: day(2) },
    { customerId: "juan", amount: pesos(1500), createdAt: day(5) },
    { customerId: "ana", amount: pesos(8000), createdAt: day(3) },
    { customerId: "luis", amount: pesos(500), createdAt: day(4) },
    { customerId: "luis", amount: pesos(-500), createdAt: day(6) },
  ];
  it("saldo = suma de movimientos", () => {
    expect(balanceOf(movs, "juan")).toBe(pesos(1500));
  });
  it("deudores ordenados por monto, con la fecha desde que deben", () => {
    expect(debtors(movs)).toEqual([
      { customerId: "ana", balance: pesos(8000), since: day(3) },
      { customerId: "juan", balance: pesos(1500), since: day(5) },
    ]);
  });
  it("límite de crédito", () => {
    expect(checkCreditLimit(pesos(4000), pesos(2000), pesos(5000))).toEqual({ ok: false, exceededBy: pesos(1000) });
    expect(checkCreditLimit(pesos(4000), pesos(1000), pesos(5000))).toEqual({ ok: true });
    expect(checkCreditLimit(pesos(99999), pesos(1), null)).toEqual({ ok: true });
  });
  it("el fiado no da vuelto", () => {
    expect(settle(pesos(1000), [{ method: "fiado", amount: pesos(1200) }])).toMatchObject({ ok: false, reason: "excede-sin-efectivo" });
    expect(settle(pesos(1000), [{ method: "fiado", amount: pesos(1000) }])).toMatchObject({ ok: true, change: 0 });
  });
});

describe("whatsapp", () => {
  it.each([
    ["011 15-1234-5678", "5491112345678"],
    ["+54 9 11 1234-5678", "5491112345678"],
    ["11 1234 5678", "5491112345678"],
    ["0351 15 612-3456", "5493516123456"],
    ["3516123456", "5493516123456"],
  ])("%s → %s", (input, expected) => {
    expect(whatsappNumber(input)).toBe(expected);
  });
  it("rechaza números incompletos", () => {
    expect(whatsappNumber("1234")).toBeNull();
    expect(whatsappLink("", "hola")).toBeNull();
  });
  it("arma el link con el mensaje", () => {
    expect(whatsappLink("1112345678", "Hola Juan")).toBe("https://wa.me/5491112345678?text=Hola%20Juan");
  });
});

describe("reportes", () => {
  const line = (productId: string | null, name: string, unitPrice: number, quantity: number) =>
    ({ lineId: `${name}${quantity}`, productId, name, unitPrice: pesos(unitPrice), unitCost: null, quantity });
  const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
  const sales: ReportSale[] = [
    { createdAt: at(20, 10), userName: "Ana", total: pesos(3000), discount: 0, status: "completada", payments: [], items: [line("coca", "Coca", 1500, 2)] },
    { createdAt: at(20, 18), userName: "Luis", total: pesos(2300), discount: 0, status: "completada", payments: [], items: [line("coca", "Coca", 1500, 1), line("alf", "Alfajor", 800, 1)] },
    { createdAt: at(22, 9), userName: "Ana", total: pesos(500), discount: 0, status: "completada", payments: [], items: [line(null, "Varios", 500, 1)] },
    { createdAt: at(22, 9), userName: "Ana", total: pesos(9999), discount: 0, status: "anulada", payments: [], items: [line("agua", "Agua", 9999, 1)] },
  ];

  it("por día, con los días vacíos", () => {
    const rows = salesByDay(sales, at(20, 0), at(23, 0));
    expect(rows.map((r) => [new Date(r.day).getDate(), r.total, r.count])).toEqual([
      [20, pesos(5300), 2],
      [21, 0, 0],
      [22, pesos(500), 1],
    ]);
  });
  it("por producto, sin anuladas", () => {
    expect(salesByProduct(sales).map((r) => [r.name, r.units, r.total])).toEqual([
      ["Coca", 3, pesos(4500)],
      ["Alfajor", 1, pesos(800)],
      ["Varios", 1, pesos(500)],
    ]);
  });
  it("por categoría", () => {
    const cat = (id: string | null) => (id === "coca" ? "Bebidas" : id === "alf" ? "Golosinas" : "Sin categoría");
    expect(salesByGroup(sales, cat).map((r) => r.group)).toEqual(["Bebidas", "Golosinas", "Sin categoría"]);
  });
  it("por cajero", () => {
    expect(salesByUser(sales)).toEqual([
      { userName: "Luis", total: pesos(2300), count: 1 },
      { userName: "Ana", total: pesos(3500), count: 2 },
    ].sort((a, b) => b.total - a.total));
  });
  it("productos sin movimiento", () => {
    const products = [{ id: "coca" }, { id: "alf" }, { id: "agua" }];
    expect(productsWithoutSales(products, sales)).toEqual([{ id: "agua" }]);
  });
});
