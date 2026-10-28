import { describe, expect, it } from "vitest";
import { pesos, remainingToPay, settle, suggestCashAmounts } from "../src";

describe("settle", () => {
  it("calcula el vuelto en efectivo", () => {
    const r = settle(pesos(4350), [{ method: "efectivo", amount: pesos(5000) }]);
    expect(r).toEqual({
      ok: true,
      change: pesos(650),
      payments: [{ method: "efectivo", amount: pesos(4350), tendered: pesos(5000) }],
    });
  });

  it("acepta pago mixto con vuelto del efectivo", () => {
    const r = settle(pesos(3000), [
      { method: "debito", amount: pesos(2000) },
      { method: "efectivo", amount: pesos(2000) },
    ]);
    expect(r.ok && r.change).toBe(pesos(1000));
    expect(r.ok && r.payments.map((p) => [p.method, p.amount])).toEqual([
      ["efectivo", pesos(1000)],
      ["debito", pesos(2000)],
    ]);
  });

  it("avisa cuánto falta", () => {
    expect(settle(pesos(3000), [{ method: "efectivo", amount: pesos(1000) }])).toEqual({
      ok: false, reason: "falta", remaining: pesos(2000),
    });
  });

  it("no da vuelto de un pago electrónico", () => {
    expect(settle(pesos(3000), [{ method: "transferencia", amount: pesos(3500) }])).toEqual({
      ok: false, reason: "excede-sin-efectivo", excess: pesos(500),
    });
  });

  it("ignora montos en cero", () => {
    const r = settle(pesos(100), [
      { method: "credito", amount: 0 },
      { method: "mercadopago", amount: pesos(100) },
    ]);
    expect(r.ok && r.payments).toEqual([{ method: "mercadopago", amount: pesos(100), reference: undefined }]);
  });

  it("remainingToPay nunca es negativo", () => {
    expect(remainingToPay(pesos(100), [{ method: "efectivo", amount: pesos(500) }])).toBe(0);
  });
});

describe("suggestCashAmounts", () => {
  it("sugiere el justo y billetes redondos", () => {
    expect(suggestCashAmounts(pesos(4350))).toEqual([pesos(4350), pesos(5000), pesos(6000), pesos(10000)]);
  });
  it("no repite montos", () => {
    expect(suggestCashAmounts(pesos(1000))).toEqual([pesos(1000), pesos(2000), pesos(10000), pesos(20000)]);
  });
});
