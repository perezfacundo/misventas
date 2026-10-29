import { useLiveQuery } from "dexie-react-hooks";
import { adjustmentDelta, DEFAULT_BRANCH_ID, movementDelta, uuidv7, type Cents, type StockMovementType } from "@misventas/core";
import { currentBranchId, db, type Product } from "../db";

const EMPTY: Product[] = [];

/** El catálogo completo en memoria: un kiosco tiene pocos miles de productos y la búsqueda es instantánea. */
export function useProducts(): Product[] {
  return useLiveQuery(
    () => db.products.filter((p) => p.active).toArray().then((ps) => ps.sort((a, b) => a.name.localeCompare(b.name, "es"))),
    [],
    EMPTY,
  );
}

export type ProductInput = Omit<Product, "id" | "stock" | "active" | "createdAt" | "updatedAt">;

export async function createProduct(input: ProductInput, initialStock: number): Promise<Product> {
  const now = Date.now();
  const product: Product = { ...input, id: uuidv7(), stock: 0, active: true, createdAt: now, updatedAt: now };
  await db.transaction("rw", db.products, db.stockMovements, async () => {
    await db.products.add(product);
    if (initialStock !== 0) await recordMovement(product.id, "inicial", initialStock);
  });
  return { ...product, stock: initialStock };
}

export async function updateProduct(id: string, patch: Partial<ProductInput>): Promise<void> {
  await db.products.update(id, { ...patch, updatedAt: Date.now() });
}

/** Borrado lógico: el producto sigue apareciendo en el historial de ventas. */
export async function archiveProduct(id: string): Promise<void> {
  await db.products.update(id, { active: false, updatedAt: Date.now() });
}

/**
 * Registra un movimiento y actualiza la proyección de stock del producto.
 * Debe llamarse dentro de una transacción que incluya products y stockMovements.
 */
export async function recordMovement(
  productId: string,
  type: StockMovementType,
  quantity: number,
  extra: { refId?: string; note?: string; delta?: number } = {},
): Promise<void> {
  const delta = extra.delta ?? movementDelta(type, quantity);
  if (delta === 0) return;
  const now = Date.now();
  await db.stockMovements.add({ id: uuidv7(), productId, delta, type, refId: extra.refId, note: extra.note, branchId: currentBranchId(), createdAt: now });
  // Solo la proyección local: el stock no se sincroniza, se sincronizan los movimientos.
  await db.products.where("id").equals(productId).modify((p) => {
    p.stock += delta;
  });
}

/** Ajuste por conteo: deja el stock en lo que se contó. */
export async function adjustStockTo(productId: string, counted: number, note?: string): Promise<void> {
  await db.transaction("rw", db.products, db.stockMovements, async () => {
    const p = await db.products.get(productId);
    if (!p) return;
    await recordMovement(productId, "ajuste", 0, { delta: adjustmentDelta(p.stock, counted), note });
  });
}

export async function recordLoss(productId: string, quantity: number, note?: string): Promise<void> {
  await db.transaction("rw", db.products, db.stockMovements, () => recordMovement(productId, "merma", quantity, { note }));
}

/** Actualización masiva de precios (y opcionalmente costos) en una sola transacción. */
export async function bulkUpdatePrices(changes: { id: string; price: Cents; cost?: Cents | null }[]): Promise<void> {
  const now = Date.now();
  await db.transaction("rw", db.products, async () => {
    for (const c of changes) {
      await db.products.update(c.id, c.cost === undefined ? { price: c.price, updatedAt: now } : { price: c.price, cost: c.cost, updatedAt: now });
    }
  });
}

/** Mantenimiento: recalcula la proyección de stock sumando todos los movimientos. */
export async function recomputeAllStock(): Promise<number> {
  return db.transaction("rw", db.products, db.stockMovements, async () => {
    const totals = new Map<string, number>();
    // El stock que ve cada dispositivo es el de su sucursal.
    const branch = currentBranchId();
    await db.stockMovements.each((m) => {
      if ((m.branchId ?? DEFAULT_BRANCH_ID) === branch) totals.set(m.productId, (totals.get(m.productId) ?? 0) + m.delta);
    });
    let fixed = 0;
    await db.products.toCollection().modify((p) => {
      const real = totals.get(p.id) ?? 0;
      if (p.stock !== real) {
        p.stock = real;
        fixed++;
      }
    });
    return fixed;
  });
}

export function catalogOptions(products: Product[]): { categories: string[] } {
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  return { categories };
}
