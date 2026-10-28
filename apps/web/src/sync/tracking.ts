import Dexie, { type Transaction } from "dexie";
import { SYNC_TABLES, type SyncTable } from "@misventas/core";
import { db } from "../db";

/** Campos que nunca viajan al servidor. */
export const LOCAL_FIELDS = new Set(["_dirty", "_df", "_rev"]);
/** Campos que cada dispositivo calcula por su cuenta. */
export const DERIVED_FIELDS: Partial<Record<SyncTable, ReadonlySet<string>>> = {
  products: new Set(["stock"]),
};

const remoteTransactions = new WeakSet<Transaction>();

/** Marca una transacción como "aplicando cambios del servidor": no genera cambios pendientes. */
export function markRemote(tx: Transaction | null | undefined): void {
  if (tx) remoteTransactions.add(tx);
}

function isRemote(tx: Transaction | null | undefined): boolean {
  for (let t: Transaction | null | undefined = tx; t; t = (t as Transaction & { parent?: Transaction }).parent) {
    if (remoteTransactions.has(t)) return true;
  }
  return false;
}

/** Corre `fn` en una transacción que no marca cambios pendientes (para aplicar lo que baja del servidor). */
export function remoteTransaction<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
  return db.transaction("rw", tables, async () => {
    markRemote(Dexie.currentTransaction);
    return fn();
  });
}

let onLocalChange: () => void = () => {};
/** El motor de sincronización se engancha acá para subir los cambios apenas ocurren. */
export function setLocalChangeListener(fn: () => void): void {
  onLocalChange = fn;
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function syncedKeys(table: SyncTable, keys: string[]): string[] {
  const derived = DERIVED_FIELDS[table];
  return [...new Set(keys.map((k) => k.split(".")[0]!))].filter((k) => !LOCAL_FIELDS.has(k) && !derived?.has(k));
}

for (const name of SYNC_TABLES) {
  const table = db.table(name);
  table.hook("creating", function (_key, obj: Record<string, unknown>, tx) {
    if (isRemote(tx)) return;
    obj._dirty = 1;
    obj._df = ["*"];
    obj._rev = 1;
    queueMicrotask(onLocalChange);
  });
  table.hook("updating", function (modifications: object, _key, row: object, tx: Transaction) {
    if (isRemote(tx)) return undefined;
    const mods = modifications as Record<string, unknown>;
    const obj = row as Record<string, unknown>;
    // Dexie puede incluir campos que no cambiaron (por ejemplo arrays con índice): solo cuentan los que cambiaron de verdad.
    const changed = Object.keys(mods).filter((k) => !sameValue(mods[k], Dexie.getByKeyPath(obj, k)));
    const keys = syncedKeys(name, changed);
    if (!keys.length) return undefined;
    const previous = (obj._df as string[] | undefined) ?? [];
    const df = previous.includes("*") ? ["*"] : [...new Set([...previous, ...keys])];
    queueMicrotask(onLocalChange);
    return { _dirty: 1, _df: df, _rev: ((obj._rev as number | undefined) ?? 0) + 1 };
  });
}
