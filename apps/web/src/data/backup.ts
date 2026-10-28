import { db } from "../db";

const TABLES = [
  "products", "stockMovements", "sales", "cashSessions", "cashMovements", "heldCarts", "meta",
  "users", "suppliers", "customers", "accountMovements", "purchases", "business",
] as const;

export async function exportBackup(): Promise<string> {
  const data: Record<string, unknown[]> = {};
  for (const t of TABLES) data[t] = await db.table(t).toArray();
  return JSON.stringify({ app: "misventas", version: 2, exportedAt: new Date().toISOString(), data });
}

/** Reemplaza todos los datos locales por los de la copia. */
export async function importBackup(json: string): Promise<void> {
  const parsed = JSON.parse(json) as { app?: string; data?: Record<string, unknown[]> };
  if (parsed.app !== "misventas" || !parsed.data) throw new Error("El archivo no es una copia de seguridad de Mis Ventas.");
  await db.transaction("rw", TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      // La cuenta en la nube de este dispositivo no viene en la copia: se conserva.
      if (t === "meta") {
        const keep = await db.meta.where("key").anyOf(["cloud", "syncCursor", "deviceId"]).toArray();
        await db.meta.clear();
        await db.meta.bulkAdd([...(parsed.data!.meta ?? []).filter((m) => !keep.some((k) => k.key === (m as { key: string }).key)) as never[], ...keep]);
        continue;
      }
      await db.table(t).clear();
      await db.table(t).bulkAdd(parsed.data![t] ?? []);
    }
  });
}
