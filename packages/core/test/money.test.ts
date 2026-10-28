import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney, pesos, roundPrice } from "../src";

describe("formatMoney", () => {
  it("oculta decimales cuando no hay centavos", () => {
    expect(formatMoney(pesos(2400))).toBe("$ 2.400");
  });
  it("muestra centavos cuando los hay", () => {
    expect(formatMoney(240050)).toBe("$ 2.400,50");
  });
});

describe("parseMoney", () => {
  it.each([
    ["1500", 150000],
    ["1.500", 150000],
    ["1.500,50", 150050],
    ["1500,5", 150050],
    ["1500.5", 150050],
    ["$ 2.000", 200000],
    ["12.345.678", 1234567800],
  ])("%s → %i", (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });
  it.each(["", "abc", "1,2,3", "-5"])("rechaza %s", (input) => {
    expect(parseMoney(input)).toBeNull();
  });
});

describe("roundPrice", () => {
  it("redondea hacia arriba a $50", () => {
    expect(roundPrice(pesos(1210), pesos(50))).toBe(pesos(1250));
    expect(roundPrice(pesos(1250), pesos(50))).toBe(pesos(1250));
  });
  it("redondea al más cercano", () => {
    expect(roundPrice(pesos(1220), pesos(50), "nearest")).toBe(pesos(1200));
  });
  it("sin paso no redondea", () => {
    expect(roundPrice(12345, 0)).toBe(12345);
  });
});
