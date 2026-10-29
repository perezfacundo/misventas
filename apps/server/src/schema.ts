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


/** Cuenta de Mercado Pago de cada comercio. El token se guarda cifrado (ver secrets.ts). */
export const mpAccounts = pgTable("mp_accounts", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  accessTokenEnc: text("access_token_enc").notNull(),
  mpUserId: text("mp_user_id").notNull(),
  nickname: text("nickname"),
  externalPosId: text("external_pos_id"),
  terminalId: text("terminal_id"),
  webhookSecretEnc: text("webhook_secret_enc"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cada cobro iniciado desde una caja (QR o Point) y su estado en Mercado Pago. */
export const mpCharges = pgTable("mp_charges", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  deviceId: uuid("device_id").notNull(),
  kind: text("kind").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  mpOrderId: text("mp_order_id").notNull(),
  mpStatus: text("mp_status").notNull(),
  status: text("status").notNull(),
  statusDetail: text("status_detail"),
  paymentId: text("payment_id"),
  qrData: text("qr_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});


/** Datos fiscales y credenciales de ARCA de cada comercio. Clave privada y ticket de acceso, cifrados. */
export const arcaConfig = pgTable("arca_config", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  cuit: text("cuit").notNull(),
  razonSocial: text("razon_social").notNull(),
  condicion: text("condicion").notNull(),
  ptoVta: bigint("pto_vta", { mode: "number" }).notNull(),
  ambiente: text("ambiente").notNull(),
  domicilio: text("domicilio").notNull().default(""),
  iibb: text("iibb").notNull().default(""),
  inicioActividades: text("inicio_actividades").notNull().default(""),
  keyEnc: text("key_enc"),
  csrPem: text("csr_pem"),
  certPem: text("cert_pem"),
  certExpiresAt: timestamp("cert_expires_at", { withTimezone: true }),
  taTokenEnc: text("ta_token_enc"),
  taSignEnc: text("ta_sign_enc"),
  taExpiresAt: timestamp("ta_expires_at", { withTimezone: true }),
  taAmbiente: text("ta_ambiente"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cada factura o nota de crédito pedida a ARCA. El id lo genera la caja: reintentar nunca emite dos veces. */
export const arcaInvoices = pgTable("arca_invoices", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  saleId: text("sale_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  ambiente: text("ambiente").notNull(),
  cbteTipo: bigint("cbte_tipo", { mode: "number" }).notNull(),
  ptoVta: bigint("pto_vta", { mode: "number" }).notNull(),
  numero: bigint("numero", { mode: "number" }),
  fecha: text("fecha"),
  cae: text("cae"),
  caeVto: text("cae_vto"),
  docTipo: bigint("doc_tipo", { mode: "number" }).notNull(),
  docNro: text("doc_nro").notNull(),
  condicionIvaReceptor: bigint("condicion_iva_receptor", { mode: "number" }).notNull(),
  receiverName: text("receiver_name"),
  total: bigint("total", { mode: "number" }).notNull(),
  amounts: jsonb("amounts").notNull(),
  messages: jsonb("messages").notNull(),
  associatedId: uuid("associated_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = { tenants, accounts, devices, entities, mpAccounts, mpCharges, arcaConfig, arcaInvoices };
