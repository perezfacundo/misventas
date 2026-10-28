import Dexie, { type EntityTable, type Transaction } from "dexie";
import type {
  AccountMovementType, Cart, CartLine, Cents, CashMovementType, Payment, PaymentMethod, Role, StockMovementType,
} from "@misventas/core";
import { uuidv7 } from "@misventas/core";

/**
 * Campos de control de sincronización, solo locales (nunca se envían):
 * _dirty = 1 si hay cambios sin subir, _df = campos modificados ("*" = registro nuevo), _rev = versión local.
 */
export interface SyncFields {
  _dirty?: 1;
  _df?: string[];
  _rev?: number;
}

export interface Product extends SyncFields {
  id: string;
  name: string;
  barcodes: string[];
  code?: string;
  category: string;
  supplierId: string | null;
  price: Cents;
  cost: Cents | null;
  /** Proyección local de la suma de movimientos de stock. No se sincroniza: cada dispositivo la recalcula. */
  stock: number;
  minStock: number;
  /** false para productos sin control de stock (por ejemplo, cargas virtuales). */
  trackStock: boolean;
  favorite: boolean;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StockMovement extends SyncFields {
  id: string;
  productId: string;
  delta: number;
  type: StockMovementType;
  /** Venta o compra que lo originó. */
  refId?: string;
  note?: string;
  createdAt: number;
}

export type SaleStatus = "completada" | "anulada";

export interface Sale extends SyncFields {
  id: string;
  number: string;
  createdAt: number;
  deviceId: string;
  cashSessionId: string;
  userId: string;
  cashier: string;
  /** Cliente al que se le fió (si hubo fiado). */
  customerId?: string;
  /** Copia de nombre y precio al momento de vender: los cambios de precio no alteran el historial. */
  items: CartLine[];
  subtotal: Cents;
  discount: Cents;
  total: Cents;
  payments: Payment[];
  change: Cents;
  status: SaleStatus;
  voidedAt?: number;
  voidReason?: string;
  voidedBy?: string;
}

export interface CashSession extends SyncFields {
  id: string;
  deviceId: string;
  status: "abierta" | "cerrada";
  openedAt: number;
  openedById: string;
  openedBy: string;
  openingAmount: Cents;
  closedAt?: number;
  closedBy?: string;
  expectedAmount?: Cents;
  countedAmount?: Cents;
  note?: string;
}

export interface CashMovement extends SyncFields {
  id: string;
  cashSessionId: string;
  type: CashMovementType;
  amount: Cents;
  reason: string;
  createdAt: number;
  userName?: string;
}

export interface User extends SyncFields {
  id: string;
  name: string;
  role: Role;
  /** null = entra sin PIN. */
  pinHash: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Supplier extends SyncFields {
  id: string;
  name: string;
  phone: string;
  contact: string;
  /** 0 = domingo … 6 = sábado. */
  visitDays: number[];
  notes: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Customer extends SyncFields {
  id: string;
  name: string;
  phone: string;
  document: string;
  /** null = sin límite. */
  creditLimit: Cents | null;
  notes: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AccountMovement extends SyncFields {
  id: string;
  customerId: string;
  type: AccountMovementType;
  /** Positivo: aumenta la deuda. Negativo: la baja. */
  amount: Cents;
  saleId?: string;
  method?: PaymentMethod;
  note?: string;
  createdAt: number;
  userName: string;
}

export interface PurchaseItem {
  productId: string;
  name: string;
  quantity: number;
  cost: Cents | null;
}

export interface Purchase extends SyncFields {
  id: string;
  supplierId: string | null;
  items: PurchaseItem[];
  total: Cents;
  paidFromCash: boolean;
  note?: string;
  createdAt: number;
  userName: string;
}

export interface HeldCart {
  id: string;
  cart: Cart;
  createdAt: number;
}

export type TextSize = "normal" | "grande" | "muy-grande";
export type Theme = "auto" | "claro" | "oscuro";

/** Datos del comercio: se comparten entre todos los dispositivos. */
export interface BusinessSettings extends SyncFields {
  id: "business";
  businessName: string;
  address: string;
  taxId: string;
  ticketFooter: string;
  /** Paso de redondeo por defecto al actualizar precios, en centavos. */
  priceRounding: Cents;
  enabledMethods: PaymentMethod[];
}

/** Preferencias de este dispositivo. */
export interface DeviceSettings {
  devicePrefix: string;
  textSize: TextSize;
  theme: Theme;
  autoPrint: boolean;
  paperWidth: 58 | 80;
  onboarded: boolean;
}

export type Settings = Omit<BusinessSettings, "id" | keyof SyncFields> & DeviceSettings;

export interface Meta {
  key: string;
  value: unknown;
}

export const db = new Dexie("misventas") as Dexie & {
  products: EntityTable<Product, "id">;
  stockMovements: EntityTable<StockMovement, "id">;
  sales: EntityTable<Sale, "id">;
  cashSessions: EntityTable<CashSession, "id">;
  cashMovements: EntityTable<CashMovement, "id">;
  heldCarts: EntityTable<HeldCart, "id">;
  meta: EntityTable<Meta, "key">;
  users: EntityTable<User, "id">;
  suppliers: EntityTable<Supplier, "id">;
  customers: EntityTable<Customer, "id">;
  accountMovements: EntityTable<AccountMovement, "id">;
  purchases: EntityTable<Purchase, "id">;
  business: EntityTable<BusinessSettings, "id">;
};

db.version(1).stores({
  products: "id, name, *barcodes, code, category, supplier, updatedAt",
  stockMovements: "id, productId, createdAt, type, refId",
  sales: "id, number, createdAt, cashSessionId, status",
  cashSessions: "id, status, openedAt",
  cashMovements: "id, cashSessionId, createdAt",
  heldCarts: "id, createdAt",
  meta: "key",
});

db.version(2)
  .stores({
    products: "id, name, *barcodes, code, category, supplierId, updatedAt, _dirty",
    stockMovements: "id, productId, createdAt, type, refId, _dirty",
    sales: "id, number, createdAt, cashSessionId, status, customerId, _dirty",
    cashSessions: "id, status, openedAt, deviceId, _dirty",
    cashMovements: "id, cashSessionId, createdAt, _dirty",
    heldCarts: "id, createdAt",
    meta: "key",
    users: "id, _dirty",
    suppliers: "id, name, _dirty",
    customers: "id, name, _dirty",
    accountMovements: "id, customerId, createdAt, saleId, _dirty",
    purchases: "id, supplierId, createdAt, _dirty",
    business: "id, _dirty",
  })
  .upgrade(migrateToV2);

/** Migración de la Fase 1: comercio compartido, usuarios, proveedores como entidad y dispositivo. */
async function migrateToV2(tx: Transaction): Promise<void> {
  const now = Date.now();
  const deviceId = uuidv7();
  await tx.table("meta").put({ key: "deviceId", value: deviceId });

  const old = ((await tx.table("meta").get("settings"))?.value ?? {}) as Record<string, unknown>;
  const methods = (old.enabledMethods as PaymentMethod[] | undefined) ?? ["efectivo", "debito", "credito", "transferencia", "mercadopago"];
  await tx.table("business").put({
    id: "business",
    businessName: (old.businessName as string) ?? "",
    address: (old.address as string) ?? "",
    taxId: (old.taxId as string) ?? "",
    ticketFooter: (old.ticketFooter as string) ?? "¡Gracias por tu compra!",
    priceRounding: (old.priceRounding as number) ?? 1000,
    enabledMethods: methods.includes("fiado") ? methods : [...methods, "fiado"],
  });
  const device: DeviceSettings = {
    devicePrefix: (old.devicePrefix as string) ?? "D01",
    textSize: (old.textSize as TextSize) ?? "normal",
    theme: (old.theme as Theme) ?? "auto",
    autoPrint: (old.autoPrint as boolean) ?? false,
    paperWidth: (old.paperWidth as 58 | 80) ?? 58,
    onboarded: (old.onboarded as boolean) ?? false,
  };
  await tx.table("meta").put({ key: "settings", value: device });

  // Proveedores: de texto libre en el producto a una entidad con datos de contacto.
  const supplierIds = new Map<string, string>();
  await tx.table("products").toCollection().modify((p: Record<string, unknown>) => {
    const name = ((p.supplier as string) ?? "").trim();
    delete p.supplier;
    if (!name) {
      p.supplierId = null;
      return;
    }
    if (!supplierIds.has(name)) supplierIds.set(name, uuidv7());
    p.supplierId = supplierIds.get(name);
  });
  for (const [name, id] of supplierIds) {
    await tx.table("suppliers").add({ id, name, phone: "", contact: "", visitDays: [], notes: "", active: true, createdAt: now, updatedAt: now });
  }

  // Usuario dueño: quien abrió la última caja (o "Dueño/a"), sin PIN hasta que lo configure.
  const sessions = await tx.table("cashSessions").toArray();
  const lastName = sessions.sort((a, b) => b.openedAt - a.openedAt)[0]?.openedBy ?? "";
  const ownerId = uuidv7();
  if (old.onboarded) {
    await tx.table("users").add({ id: ownerId, name: lastName || "Dueño/a", role: "dueno", pinHash: null, active: true, createdAt: now, updatedAt: now });
  }
  await tx.table("cashSessions").toCollection().modify((s: Record<string, unknown>) => {
    s.deviceId = deviceId;
    s.openedById = ownerId;
  });
  await tx.table("sales").toCollection().modify((s: Record<string, unknown>) => {
    s.deviceId = deviceId;
    s.userId = ownerId;
  });
}

let deviceId: string | undefined;

/**
 * Crea (si hace falta) el id local de este dispositivo. Se llama al arrancar, antes de mostrar la app,
 * porque las consultas en vivo son de solo lectura y no pueden crearlo.
 */
export async function initDeviceId(): Promise<string> {
  const row = await db.meta.get("deviceId");
  deviceId = (row?.value as string | undefined) ?? uuidv7();
  if (!row) await db.meta.put({ key: "deviceId", value: deviceId });
  return deviceId;
}

/** Id local de este dispositivo (distinto del id que le asigna el servidor al vincularlo). */
export async function getDeviceId(): Promise<string> {
  return deviceId ?? initDeviceId();
}

/** Pide al navegador que no borre los datos locales cuando falte espacio. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    // Algunos navegadores no lo soportan; la app funciona igual.
  }
}
