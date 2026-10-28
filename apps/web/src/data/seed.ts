import { pesos } from "@misventas/core";
import { createProduct, type ProductInput } from "./products";
import { createSupplier } from "./suppliers";

type Seed = [name: string, category: string, price: number, cost: number, stock: number, favorite?: boolean];

const SAMPLE: Seed[] = [
  ["Gaseosa cola 500 ml", "Bebidas", 1500, 950, 24, true],
  ["Gaseosa lima 500 ml", "Bebidas", 1400, 900, 12],
  ["Agua mineral 500 ml", "Bebidas", 900, 520, 30, true],
  ["Agua saborizada 500 ml", "Bebidas", 1200, 750, 10],
  ["Jugo en caja 200 ml", "Bebidas", 700, 420, 18],
  ["Bebida energizante 473 ml", "Bebidas", 2600, 1700, 6],
  ["Alfajor simple", "Golosinas", 800, 480, 40, true],
  ["Alfajor triple", "Golosinas", 1300, 800, 20, true],
  ["Chocolate con leche 25 g", "Golosinas", 1100, 680, 15],
  ["Chicles de menta", "Golosinas", 600, 330, 25, true],
  ["Caramelos (unidad)", "Golosinas", 100, 45, 200],
  ["Turrón de maní", "Golosinas", 450, 260, 30],
  ["Galletitas dulces 150 g", "Almacén", 1600, 1000, 12],
  ["Papas fritas 80 g", "Snacks", 2200, 1400, 3],
  ["Maní salado 100 g", "Snacks", 1500, 900, 8],
  ["Cigarrillos atado 20", "Cigarrillos", 3800, 3300, 20, true],
  ["Encendedor", "Varios", 1200, 600, 14],
  ["Pañuelitos descartables", "Varios", 700, 380, 2],
  ["Pilas AA x2", "Varios", 2800, 1700, 5],
  ["Café en vaso", "Cafetería", 1800, 500, 0],
];

/** Productos de ejemplo para practicar. Se pueden archivar después desde Productos. */
export async function seedSampleProducts(): Promise<void> {
  const bebidas = await createSupplier({ name: "Distribuidora Norte", phone: "", contact: "", visitDays: [2, 5], notes: "" });
  const golosinas = await createSupplier({ name: "Golosinas del Sur", phone: "", contact: "", visitDays: [1], notes: "" });
  const supplierFor: Record<string, string> = { Bebidas: bebidas.id, Golosinas: golosinas.id, Snacks: golosinas.id };
  let i = 1;
  for (const [name, category, price, cost, stock, favorite] of SAMPLE) {
    const input: ProductInput = {
      name,
      category,
      supplierId: supplierFor[category] ?? null,
      barcodes: [`200000000${String(i).padStart(4, "0")}`],
      code: String(i),
      price: pesos(price),
      cost: pesos(cost),
      minStock: name.startsWith("Caramelos") ? 50 : 4,
      trackStock: category !== "Cafetería",
      favorite: favorite ?? false,
    };
    await createProduct(input, stock);
    i++;
  }
}
