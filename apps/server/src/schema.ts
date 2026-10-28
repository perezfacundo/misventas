import { bigint, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cuentas que pueden vincular dispositivos (el dueño). El resto de los usuarios entra con PIN en el mostrador. */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  /** Prefijo de numeración de comprobantes: D01, D02... */
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * Estado actual de cada registro sincronizado (productos, ventas, movimientos...), como JSON.
 * `seq` crece en cada escritura: un dispositivo pide "todo lo que cambió después de mi cursor".
 */
export const entities = pgTable(
  "entities",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    tbl: text("tbl").notNull(),
    id: text("id").notNull(),
    data: jsonb("data").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.tbl, t.id] }), index("entities_tenant_seq").on(t.tenantId, t.seq)],
);

export const schema = { tenants, accounts, devices, entities };
