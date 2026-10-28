import { mkdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { schema } from "./schema.ts";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/**
 * Con DATABASE_URL usa PostgreSQL. Sin ella, PGlite: el mismo PostgreSQL embebido,
 * en una carpeta (desarrollo) o en memoria (tests). No hace falta instalar nada.
 */
export async function openDb(options: { url?: string; dataDir?: string } = {}): Promise<DbHandle> {
  if (options.url) {
    const client = postgres(options.url, { max: 10 });
    const db = drizzlePostgres(client, { schema }) as unknown as Db;
    await migrate(db);
    return { db, close: () => client.end() };
  }
  if (options.dataDir) mkdirSync(options.dataDir, { recursive: true });
  const client = new PGlite(options.dataDir);
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  await migrate(db);
  return { db, close: () => client.close() };
}

/** postgres-js devuelve un array; PGlite, `{ rows }`. */
export function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE tenants (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE devices (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL,
    prefix text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    revoked_at timestamptz,
    UNIQUE (tenant_id, prefix)
  );
  CREATE SEQUENCE entity_seq;
  CREATE TABLE entities (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    tbl text NOT NULL,
    id text NOT NULL,
    data jsonb NOT NULL,
    seq bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    PRIMARY KEY (tenant_id, tbl, id)
  );
  CREATE INDEX entities_tenant_seq ON entities (tenant_id, seq);
  `,
  `
  CREATE TABLE mp_accounts (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    access_token_enc text NOT NULL,
    mp_user_id text NOT NULL,
    nickname text,
    external_pos_id text,
    terminal_id text,
    webhook_secret_enc text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE mp_charges (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    device_id uuid NOT NULL,
    kind text NOT NULL,
    amount bigint NOT NULL,
    mp_order_id text NOT NULL,
    mp_status text NOT NULL,
    status text NOT NULL,
    status_detail text,
    payment_id text,
    qr_data text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX mp_charges_order ON mp_charges (lower(mp_order_id));
  CREATE INDEX mp_charges_tenant ON mp_charges (tenant_id, created_at);
  `,
];

async function migrate(db: Db): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set(rows<{ version: number }>(await db.execute(sql`SELECT version FROM schema_migrations`)).map((r) => r.version));
  for (const [i, migration] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (applied.has(version)) continue;
    await db.transaction(async (tx) => {
      // Una sentencia por consulta: los drivers con protocolo extendido no aceptan varias juntas.
      for (const statement of migration.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
        await tx.execute(sql.raw(statement));
      }
      await tx.execute(sql`INSERT INTO schema_migrations (version) VALUES (${version})`);
    });
  }
}
