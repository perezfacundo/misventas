import type { Cents } from "./money.ts";
import { uuidv7 } from "./ids.ts";

export interface CartLine {
  lineId: string;
  /** null para "Varios" (precio libre, producto no cargado). */
  productId: string | null;
  name: string;
  unitPrice: Cents;
  /** Costo al momento de vender, para estimar la ganancia. null si no se conoce. */
  unitCost: Cents | null;
  quantity: number;
}

export interface Cart {
  lines: CartLine[];
  /** Descuento sobre el total, en centavos. */
  discount: Cents;
}

export interface SellableProduct {
  id: string;
  name: string;
  price: Cents;
  cost: Cents | null;
}

export const emptyCart = (): Cart => ({ lines: [], discount: 0 });

export const lineTotal = (line: CartLine): Cents => line.unitPrice * line.quantity;

export const cartSubtotal = (cart: Cart): Cents =>
  cart.lines.reduce((sum, l) => sum + lineTotal(l), 0);

export const cartTotal = (cart: Cart): Cents =>
  Math.max(0, cartSubtotal(cart) - cart.discount);

export const itemCount = (cart: Cart): number =>
  cart.lines.reduce((sum, l) => sum + l.quantity, 0);

/** Agrega un producto; si ya está en el carrito, suma cantidad en la misma línea. */
export function addProduct(cart: Cart, product: SellableProduct, quantity = 1): Cart {
  const existing = cart.lines.find((l) => l.productId === product.id);
  if (existing) {
    return setQuantity(cart, existing.lineId, existing.quantity + quantity);
  }
  const line: CartLine = {
    lineId: uuidv7(),
    productId: product.id,
    name: product.name,
    unitPrice: product.price,
    unitCost: product.cost,
    quantity,
  };
  return { ...cart, lines: [...cart.lines, line] };
}

/** "Varios": un ítem con precio libre que no está en el catálogo. */
export function addMisc(cart: Cart, price: Cents, name = "Varios"): Cart {
  const line: CartLine = {
    lineId: uuidv7(),
    productId: null,
    name,
    unitPrice: price,
    unitCost: null,
    quantity: 1,
  };
  return { ...cart, lines: [...cart.lines, line] };
}

/** Cantidad 0 o menor elimina la línea. */
export function setQuantity(cart: Cart, lineId: string, quantity: number): Cart {
  if (quantity <= 0) return removeLine(cart, lineId);
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.lineId === lineId ? { ...l, quantity } : l)),
  };
}

export function removeLine(cart: Cart, lineId: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.lineId !== lineId) };
}

export function setDiscount(cart: Cart, discount: Cents): Cart {
  return { ...cart, discount: Math.min(Math.max(0, discount), cartSubtotal(cart)) };
}

/** Ganancia estimada: solo cuenta las líneas con costo conocido, y descuenta el descuento. */
export function estimatedProfit(lines: readonly CartLine[], discount: Cents = 0): Cents {
  const margin = lines.reduce(
    (sum, l) => (l.unitCost === null ? sum : sum + (l.unitPrice - l.unitCost) * l.quantity),
    0,
  );
  return margin - discount;
}
