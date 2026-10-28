import { describe, expect, it } from "vitest";
import {
  addMisc, addProduct, cartSubtotal, cartTotal, emptyCart, estimatedProfit,
  itemCount, pesos, removeLine, setDiscount, setQuantity,
} from "../src";

const coca = { id: "coca", name: "Coca-Cola 500ml", price: pesos(1200), cost: pesos(800) };
const alfajor = { id: "alf", name: "Alfajor", price: pesos(950), cost: null };

describe("carrito", () => {
  it("agrupa el mismo producto en una línea", () => {
    let cart = addProduct(emptyCart(), coca);
    cart = addProduct(cart, coca);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.quantity).toBe(2);
    expect(cartTotal(cart)).toBe(pesos(2400));
  });

  it("Varios siempre crea una línea nueva", () => {
    let cart = addMisc(emptyCart(), pesos(500));
    cart = addMisc(cart, pesos(500));
    expect(cart.lines).toHaveLength(2);
    expect(itemCount(cart)).toBe(2);
  });

  it("cantidad 0 elimina la línea", () => {
    const cart = addProduct(emptyCart(), coca);
    expect(setQuantity(cart, cart.lines[0]!.lineId, 0).lines).toHaveLength(0);
    expect(removeLine(cart, cart.lines[0]!.lineId).lines).toHaveLength(0);
  });

  it("el descuento no puede superar el subtotal", () => {
    const cart = setDiscount(addProduct(emptyCart(), coca), pesos(5000));
    expect(cart.discount).toBe(cartSubtotal(cart));
    expect(cartTotal(cart)).toBe(0);
  });

  it("la ganancia solo cuenta productos con costo", () => {
    let cart = addProduct(emptyCart(), coca, 2);
    cart = addProduct(cart, alfajor);
    expect(estimatedProfit(cart.lines)).toBe(pesos(800));
    expect(estimatedProfit(cart.lines, pesos(100))).toBe(pesos(700));
  });
});
