/** Tablas que se sincronizan entre dispositivos. El servidor rechaza cualquier otra. */
export const SYNC_TABLES = [
  "business",
  "users",
  "suppliers",
  "products",
  "customers",
  "stockMovements",
  "sales",
  "cashSessions",
  "cashMovements",
  "accountMovements",
  "purchases",
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

export const isSyncTable = (t: string): t is SyncTable => (SYNC_TABLES as readonly string[]).includes(t);

/** Un cambio local: solo los campos modificados (o el registro completo si es nuevo). */
export interface PushChange {
  table: SyncTable;
  id: string;
  patch: Record<string, unknown>;
}

/** Estado actual de un registro en el servidor, con su número de secuencia. */
export interface PulledEntity {
  table: SyncTable;
  id: string;
  data: Record<string, unknown>;
  seq: number;
}

export const PUSH_BATCH = 200;
export const PULL_LIMIT = 500;
