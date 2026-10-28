import { describe, expect, it } from "vitest";
import { adjustmentDelta, movementDelta, stockFromMovements, stockStatus } from "../src";

describe("stock por movimientos", () => {
  it("las ventas y mermas restan, el resto suma", () => {
    expect(movementDelta("venta", 3)).toBe(-3);
    expect(movementDelta("merma", 1)).toBe(-1);
    expect(movementDelta("compra", 12)).toBe(12);
    expect(movementDelta("anulacion", 3)).toBe(3);
  });

  it("dos cajas que venden offline el último producto quedan en negativo, sin perder ventas", () => {
    const movs = [
      { productId: "coca", delta: 1 },
      { productId: "coca", delta: -1 }, // caja 1
      { productId: "coca", delta: -1 }, // caja 2
      { productId: "agua", delta: 5 },
    ];
    expect(stockFromMovements(movs, "coca")).toBe(-1);
    expect(stockStatus(-1, 2)).toBe("agotado");
  });

  it("el ajuste lleva el stock a lo contado", () => {
    expect(adjustmentDelta(7, 4)).toBe(-3);
    expect(adjustmentDelta(-1, 6)).toBe(7);
  });

  it("estado según el mínimo", () => {
    expect(stockStatus(2, 2)).toBe("bajo");
    expect(stockStatus(3, 2)).toBe("ok");
  });
});
