import { useSyncExternalStore } from "react";
import { PULL_LIMIT, PUSH_BATCH, SYNC_TABLES, type PulledEntity, type PushChange, type SyncTable } from "@misventas/core";
import { db } from "../db";
import { DERIVED_FIELDS, LOCAL_FIELDS, remoteTransaction, setLocalChangeListener } from "./tracking";

/** Vínculo de este dispositivo con la cuenta del comercio en el servidor. */
export interface CloudLink {
  tenantId: string;
  tenantName: string;
  serverDeviceId: string;
  prefix: string;
  token: string;
  email: string;
  linkedAt: number;
}

export type SyncState = "local" | "idle" | "syncing" | "offline" | "error" | "revoked";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncAt?: number;
  message?: string;
}

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

/**
 * En el navegador la API está en el mismo origen (/api). La app de escritorio no tiene servidor propio:
 * necesita VITE_API_URL al compilarla para poder sincronizar.
 */
export const serverConfigured = (): boolean => API !== "" || !("__TAURI_INTERNALS__" in window);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network", "No hay conexión con el servidor.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? "error", body.message ?? "Algo salió mal.");
  return body as T;
}

// --- Estado observable (para la barra de estado y Ajustes) ---

let status: SyncStatus = { state: "local", pending: 0 };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

export async function getCloudLink(): Promise<CloudLink | undefined> {
  return (await db.meta.get("cloud"))?.value as CloudLink | undefined;
}

export async function countPending(): Promise<number> {
  let n = 0;
  for (const t of SYNC_TABLES) n += await db.table(t).where("_dirty").equals(1).count();
  return n;
}

// --- Vincular / desvincular ---

interface AuthResponse {
  tenant: { id: string; name: string };
  device: { id: string; prefix: string; token: string };
}

export async function registerAccount(input: { businessName: string; email: string; password: string; deviceName: string }): Promise<void> {
  const owner = (await db.users.toArray()).find((u) => u.role === "dueno" && u.active);
  const res = await api<AuthResponse>("/api/auth/register", { method: "POST", body: JSON.stringify({ ...input, ownerUserId: owner?.id }) });
  await link(res, input.email);
}

export async function loginAccount(input: { email: string; password: string; deviceName: string }): Promise<void> {
  const res = await api<AuthResponse>("/api/auth/login", { method: "POST", body: JSON.stringify(input) });
  await link(res, input.email);
}

async function link(res: AuthResponse, email: string): Promise<void> {
  const cloud: CloudLink = {
    tenantId: res.tenant.id,
    tenantName: res.tenant.name,
    serverDeviceId: res.device.id,
    prefix: res.device.prefix,
    token: res.device.token,
    email: email.trim().toLowerCase(),
    linkedAt: Date.now(),
  };
  await remoteTransaction([...SYNC_TABLES, "meta"], async () => {
    await db.meta.put({ key: "cloud", value: cloud });
    await db.meta.put({ key: "syncCursor", value: 0 });
    // El servidor asigna el prefijo para que los números de comprobante no se repitan entre cajas.
    const settings = ((await db.meta.get("settings"))?.value ?? {}) as Record<string, unknown>;
    await db.meta.put({ key: "settings", value: { ...settings, devicePrefix: cloud.prefix } });
    // Todo lo que ya había en este dispositivo se sube completo.
    for (const t of SYNC_TABLES) {
      await db.table(t).toCollection().modify((row: Record<string, unknown>) => {
        row._dirty = 1;
        row._df = ["*"];
        row._rev = ((row._rev as number | undefined) ?? 0) + 1;
      });
    }
  });
  connectEvents(cloud);
  await syncNow();
}

/** Deja de sincronizar. Los datos quedan en el dispositivo. */
export async function unlink(): Promise<void> {
  await db.meta.delete("cloud");
  await db.meta.delete("syncCursor");
  events?.close();
  events = null;
  setStatus({ state: "local", message: undefined });
}

export interface LinkedDevice {
  id: string;
  name: string;
  prefix: string;
  lastSeenAt: string | null;
  revoked: boolean;
  current: boolean;
}

export async function listDevices(): Promise<LinkedDevice[]> {
  const cloud = await getCloudLink();
  if (!cloud) return [];
  return api<LinkedDevice[]>("/api/devices", {}, cloud.token);
}

export async function revokeDevice(id: string): Promise<void> {
  const cloud = await getCloudLink();
  if (cloud) await api(`/api/devices/${id}`, { method: "DELETE" }, cloud.token);
}

// --- Subir y bajar ---

function toPatch(table: SyncTable, row: Record<string, unknown>): Record<string, unknown> {
  const df = (row._df as string[] | undefined) ?? ["*"];
  const derived = DERIVED_FIELDS[table];
  const keys = df.includes("*") ? Object.keys(row) : df;
  const patch: Record<string, unknown> = {};
  for (const k of keys) {
    if (LOCAL_FIELDS.has(k) || derived?.has(k) || k === "id") continue;
    // undefined no existe en JSON: se manda null para que el campo se borre también en el resto.
    patch[k] = row[k] === undefined ? null : row[k];
  }
  return patch;
}

async function push(cloud: CloudLink): Promise<void> {
  const pending: (PushChange & { rev: number })[] = [];
  for (const table of SYNC_TABLES) {
    const dirty = (await db.table(table).where("_dirty").equals(1).toArray()) as Record<string, unknown>[];
    for (const row of dirty) pending.push({ table, id: row.id as string, patch: toPatch(table, row), rev: (row._rev as number) ?? 0 });
  }
  for (let i = 0; i < pending.length; i += PUSH_BATCH) {
    const batch = pending.slice(i, i + PUSH_BATCH);
    await api("/api/sync/push", { method: "POST", body: JSON.stringify({ changes: batch.map(({ rev: _rev, ...c }) => c) }) }, cloud.token);
    // Si el registro cambió mientras se subía, queda pendiente para el próximo ciclo.
    await remoteTransaction([...SYNC_TABLES], async () => {
      for (const c of batch) {
        const t = db.table(c.table);
        const row = (await t.get(c.id)) as Record<string, unknown> | undefined;
        if (!row || row._rev !== c.rev) continue;
        delete row._dirty;
        delete row._df;
        await t.put(row);
      }
    });
  }
}

async function pull(cloud: CloudLink): Promise<void> {
  for (;;) {
    const since = ((await db.meta.get("syncCursor"))?.value as number | undefined) ?? 0;
    const res = await api<{ changes: PulledEntity[]; cursor: number; hasMore: boolean }>(
      `/api/sync/pull?since=${since}&limit=${PULL_LIMIT}`,
      {},
      cloud.token,
    );
    if (res.changes.length) await applyRemote(res.changes, res.cursor);
    if (!res.hasMore) return;
  }
}

/** Aplica lo que bajó del servidor sin pisar los cambios locales que todavía no se subieron. */
export async function applyRemote(changes: PulledEntity[], cursor: number): Promise<void> {
  await remoteTransaction([...SYNC_TABLES, "meta"], async () => {
    const affected = new Set<string>();
    for (const change of changes) {
      const table = db.table(change.table);
      const derived = DERIVED_FIELDS[change.table];
      const data = Object.fromEntries(Object.entries(change.data).filter(([k]) => !derived?.has(k) && !LOCAL_FIELDS.has(k)));
      const local = (await table.get(change.id)) as Record<string, unknown> | undefined;
      if (!local) {
        await table.put({ ...(change.table === "products" ? { stock: 0 } : {}), ...data, id: change.id });
      } else if (local._dirty) {
        const df = (local._df as string[] | undefined) ?? [];
        const keep = new Set(df.includes("*") ? Object.keys(local) : df);
        const merged = { ...local };
        for (const [k, v] of Object.entries(data)) if (!keep.has(k)) merged[k] = v;
        await table.put(merged);
      } else {
        await table.put({ ...local, ...data });
      }
      if (change.table === "stockMovements") affected.add((data.productId ?? local?.productId) as string);
      if (change.table === "products" && !local) affected.add(change.id);
    }
    // El stock es la suma de los movimientos: se recalcula para los productos que recibieron movimientos.
    for (const productId of affected) {
      let stock = 0;
      await db.stockMovements.where("productId").equals(productId).each((m) => {
        stock += m.delta;
      });
      await db.products.update(productId, { stock });
    }
    await db.meta.put({ key: "syncCursor", value: cursor });
  });
}

// --- Ciclo de sincronización ---

const afterSync: (() => Promise<void> | void)[] = [];
/** Tareas que corren después de cada sincronización exitosa (por ejemplo, emitir facturas pendientes). */
export function onSynced(fn: () => Promise<void> | void): void {
  afterSync.push(fn);
}

let running: Promise<void> | null = null;
let again = false;

/** Sube lo pendiente y baja lo nuevo. Si ya hay una sincronización en curso, encola otra. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

async function syncOnce(): Promise<void> {
  const cloud = await getCloudLink();
  const pending = await countPending();
  if (!cloud) return setStatus({ state: "local", pending });
  if (status.state === "revoked") return;
  if (!navigator.onLine) return setStatus({ state: "offline", pending });
  setStatus({ state: "syncing", pending });
  try {
    await push(cloud);
    await pull(cloud);
    setStatus({ state: "idle", pending: await countPending(), lastSyncAt: Date.now(), message: undefined });
    for (const fn of afterSync) void fn();
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, "error", String(e));
    if (err.status === 401) {
      events?.close();
      setStatus({ state: "revoked", pending: await countPending(), message: err.message });
    } else {
      setStatus({ state: err.status === 0 ? "offline" : "error", pending: await countPending(), message: err.message });
    }
  }
}

let events: EventSource | null = null;

/** Avisos del servidor en tiempo real: otro dispositivo guardó algo y hay que bajarlo. */
function connectEvents(cloud: CloudLink): void {
  events?.close();
  if (typeof EventSource === "undefined") return;
  events = new EventSource(`${API}/api/sync/events?token=${encodeURIComponent(cloud.token)}`);
  events.addEventListener("changed", () => void syncNow());
  // Confirmaciones de Mercado Pago: la pantalla de cobro escucha este evento.
  events.addEventListener("payment", (e) => {
    window.dispatchEvent(new CustomEvent(PAYMENT_EVENT, { detail: JSON.parse((e as MessageEvent<string>).data) }));
  });
}

export const PAYMENT_EVENT = "misventas:pago";

let debounce: ReturnType<typeof setTimeout> | undefined;
let started = false;

export async function startSync(): Promise<void> {
  if (started) return;
  started = true;
  setLocalChangeListener(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void syncNow(), 1200);
  });
  window.addEventListener("online", () => void syncNow());
  window.addEventListener("offline", () => setStatus({ state: status.state === "local" ? "local" : "offline" }));
  setInterval(() => void syncNow(), 30_000);
  const cloud = await getCloudLink();
  if (cloud) connectEvents(cloud);
  await syncNow();
}
