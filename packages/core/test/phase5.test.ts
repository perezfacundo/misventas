import { describe, expect, it } from "vitest";
import {
  addProduct, applyPromotions, cartTotal, daysUntil, emptyCart, expiringLots, isPromotionActive, lotRemaining, movementDelta,
  pesos, setDiscount, stockByBranch, stockFromMovements, summarizeSales, type CartLine, type Promotion,
} from "../src";

const line = (productId: string, price: number, quantity: number): CartLine =>
  ({ lineId: `${productId}-${quantity}`, productId, name: productId, unitPrice: pesos(price), unitCost: null, quantity });
const promo = (p: Partial<Promotion> & Pick<Promotion, "kind">): Promotion => ({ id: p.kind, name: p.kind, active: true, productIds: [], ...p });
const NOW = new Date(2026, 9, 28, 15, 30); // miércoles

describe("promociones", () => {
  it("2×1: cada dos unidades se bonifica la más barata", () => {
    const p = promo({ kind: "nxm", buy: 2, pay: 1, productIds: ["alf-a", "alf-b"] });
    const applied = applyPromotions([line("alf-a", 1000, 2), line("alf-b", 800, 1)], [p], NOW);
    // 3 alfajores: un grupo de 2 (los de $1000) → se regala uno de $1000; el tercero no completa grupo.
    expect(applied).toEqual([{ promotionId: "nxm", name: "nxm", amount: pesos(1000), times: 1 }]);
  });

  it("3×2 entre sabores mezclados regala el más barato de cada grupo", () => {
    const p = promo({ kind: "nxm", buy: 3, pay: 2, productIds: ["a", "b"] });
    const applied = applyPromotions([line("a", 1200, 3), line("b", 900, 3)], [p], NOW);
    // Orden por precio: 1200,1200,1200 | 900,900,900 → se regala 1200 y 900.
    expect(applied[0]!.amount).toBe(pesos(2100));
    expect(applied[0]!.times).toBe(2);
  });

  it("combo a precio fijo, tantas veces como se pueda, y solo si conviene", () => {
    const combo = promo({ kind: "combo", comboItems: [{ productId: "coca", quantity: 1 }, { productId: "alf", quantity: 1 }], comboPrice: pesos(2000) });
    expect(applyPromotions([line("coca", 1500, 2), line("alf", 800, 1)], [combo], NOW)).toEqual([
      { promotionId: "combo", name: "combo", amount: pesos(300), times: 1 },
    ]);
    const carisimo = { ...combo, comboPrice: pesos(9000) };
    expect(applyPromotions([line("coca", 1500, 1), line("alf", 800, 1)], [carisimo], NOW)).toEqual([]);
  });

  it("porcentaje por categoría, sobre lo que no entró en otra promo", () => {
    const combo = promo({ kind: "combo", comboItems: [{ productId: "coca", quantity: 1 }, { productId: "alf", quantity: 1 }], comboPrice: pesos(2000) });
    const golosinas = promo({ kind: "porcentaje", percent: 10, categories: ["Golosinas"] });
    const categoryOf = (id: string) => (id.startsWith("alf") || id === "chicle" ? "Golosinas" : "Bebidas");
    const applied = applyPromotions([line("coca", 1500, 1), line("alf", 800, 2), line("chicle", 600, 1)], [golosinas, combo], NOW, categoryOf);
    // El combo usa un alfajor; el 10% va sobre el otro alfajor ($800) y el chicle ($600) = $140.
    expect(applied.map((a) => [a.promotionId, a.amount])).toEqual([["combo", pesos(300)], ["porcentaje", pesos(140)]]);
  });

  it("vigencia por fechas, días y horario (también cruzando medianoche)", () => {
    const base = promo({ kind: "porcentaje", percent: 10 });
    expect(isPromotionActive({ ...base, active: false }, NOW)).toBe(false);
    expect(isPromotionActive({ ...base, schedule: { from: "2026-11-01" } }, NOW)).toBe(false);
    expect(isPromotionActive({ ...base, schedule: { to: "2026-10-28" } }, NOW)).toBe(true);
    expect(isPromotionActive({ ...base, schedule: { weekdays: [1, 2] } }, NOW)).toBe(false);
    expect(isPromotionActive({ ...base, schedule: { weekdays: [3] } }, NOW)).toBe(true);
    expect(isPromotionActive({ ...base, schedule: { fromTime: "15:00", toTime: "16:00" } }, NOW)).toBe(true);
    expect(isPromotionActive({ ...base, schedule: { fromTime: "22:00", toTime: "02:00" } }, NOW)).toBe(false);
    expect(isPromotionActive({ ...base, schedule: { fromTime: "22:00", toTime: "02:00" } }, new Date(2026, 9, 28, 1, 0))).toBe(true);
  });

  it("el total del carrito y el descuento manual respetan las promociones", () => {
    let cart = addProduct(emptyCart(), { id: "a", name: "A", price: pesos(1000), cost: pesos(600) }, 2);
    cart = { ...cart, promotions: [{ promotionId: "p", name: "2×1", amount: pesos(1000), times: 1 }] };
    expect(cartTotal(cart)).toBe(pesos(1000));
    expect(setDiscount(cart, pesos(5000)).discount).toBe(pesos(1000));
  });

  it("la ganancia estimada descuenta las promociones", () => {
    const sale = { total: pesos(1000), discount: 0, status: "completada" as const, payments: [], items: [{ ...line("a", 1000, 2), unitCost: pesos(600) }], promotions: [{ amount: pesos(1000) }] };
    expect(summarizeSales([sale]).profit).toBe(pesos(-200));
  });
});

describe("vencimientos", () => {
  const lots = [
    { id: "viejo", productId: "yogur", expiresAt: "2026-10-30", quantity: 10, discarded: 0 },
    { id: "nuevo", productId: "yogur", expiresAt: "2026-11-20", quantity: 10, discarded: 0 },
  ];
  it("el stock se asigna a los lotes que vencen más tarde (se vende primero lo más viejo)", () => {
    const r = lotRemaining(lots, 13);
    expect(r.get("nuevo")).toBe(10);
    expect(r.get("viejo")).toBe(3);
    expect(lotRemaining(lots, 5).get("viejo")).toBe(0);
  });
  it("las bajas no se cuentan dos veces", () => {
    expect(lotRemaining([{ ...lots[0]!, discarded: 8 }, lots[1]!], 15).get("viejo")).toBe(2);
  });
  it("lista lo que vence pronto, del más urgente al menos", () => {
    const soon = expiringLots(lots, () => 13, "2026-10-28", 7);
    expect(soon.map((s) => [s.lot.id, s.remaining, s.daysLeft])).toEqual([["viejo", 3, 2]]);
    expect(expiringLots(lots, () => 13, "2026-11-25", 7).map((s) => s.lot.id)).toEqual(["viejo", "nuevo"]);
    expect(daysUntil("2026-11-01", "2026-10-28")).toBe(4);
  });
});

describe("sucursales", () => {
  it("el stock se cuenta por sucursal (sin dato = principal)", () => {
    const movs = [
      { productId: "coca", delta: 24 },
      { productId: "coca", delta: movementDelta("transferencia_salida", 6) },
      { productId: "coca", delta: movementDelta("transferencia_entrada", 6), branchId: "centro" },
      { productId: "coca", delta: -1, branchId: "centro" },
    ];
    expect(stockFromMovements(movs, "coca", "principal")).toBe(18);
    expect(stockFromMovements(movs, "coca", "centro")).toBe(5);
    expect(stockFromMovements(movs, "coca")).toBe(23);
    expect([...stockByBranch(movs, "coca")]).toEqual([["principal", 18], ["centro", 5]]);
  });
});
