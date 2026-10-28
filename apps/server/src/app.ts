import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isSyncTable, PULL_LIMIT, type PulledEntity, type PushChange, type SyncTable } from "@misventas/core";
import { rows, type Db } from "./db.ts";
import { accounts, devices, tenants } from "./schema.ts";
import { hashPassword, hashToken, newDeviceToken, verifyPassword } from "./security.ts";
import { SyncHub } from "./events.ts";
import { ApiError } from "./errors.ts";
import { registerPayments } from "./payments.ts";
import { SecretBox } from "./secrets.ts";

export interface AppOptions {
  db: Db;
  hub?: SyncHub;
  /** Carpeta con el build de la app web, para servir todo desde un mismo lugar. */
  webDist?: string;
  logger?: boolean;
  rateLimit?: boolean;
  /** Clave para cifrar los tokens de Mercado Pago. Sin ella, Mercado Pago queda deshabilitado. */
  appSecret?: string;
  /** Base de la API de Mercado Pago (se cambia en los tests por un Mercado Pago falso). */
  mpApiUrl?: string;
  /** URL pública del servidor, para mostrar la dirección del webhook. */
  publicUrl?: string;
  /** Orígenes extra permitidos por CORS (la app de escritorio ya está incluida). */
  corsOrigins?: string[];
  /**
   * Versión de prueba pública: la app muestra un aviso, Mercado Pago no se puede conectar
   * (nadie debería vincular su cuenta real) y se les pide a los buscadores que no indexen el sitio.
   */
  demo?: boolean;
}

interface DeviceContext {
  deviceId: string;
  tenantId: string;
}

/** La app de escritorio (Tauri) carga la interfaz desde estos orígenes y habla con el servidor por CORS. */
const DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Oculta credenciales en URLs que se escriben en los logs. */
export const redactUrl = (url: string) => url.replace(/([?&]token=)[^&]*/g, "$1***");
const MAX_PUSH = 500;

export async function buildApp(opts: AppOptions) {
  const { db } = opts;
  const hub = opts.hub ?? new SyncHub();
  const app = Fastify({
    logger: opts.logger
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          // Los avisos en tiempo real llevan el token del dispositivo en la URL: nunca tiene que quedar en los logs.
          serializers: {
            req: (req) => ({ method: req.method, url: redactUrl(req.url) }),
          },
        }
      : false,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });

  if (opts.rateLimit !== false) await app.register(rateLimit, { global: false });
  const allowedOrigins = new Set([...DESKTOP_ORIGINS, ...(opts.corsOrigins ?? [])]);
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)), methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.status(400).send({ error: "invalid", message: "Faltan datos o no son válidos." });
    if (e.statusCode === 429) return reply.status(429).send({ error: "rate_limited", message: "Demasiados intentos. Esperá un minuto." });
    app.log.error(err);
    return reply.status(500).send({ error: "server", message: "Error del servidor. Probá de nuevo en un rato." });
  });

  // --- Autenticación de dispositivos ---

  async function authenticate(req: FastifyRequest): Promise<DeviceContext> {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : (req.query as { token?: string } | undefined)?.token;
    if (!token) throw new ApiError(401, "unauthorized", "Este dispositivo no está vinculado.");
    const [device] = await db.select().from(devices).where(eq(devices.tokenHash, hashToken(token))).limit(1);
    if (!device) throw new ApiError(401, "unauthorized", "Este dispositivo no está vinculado.");
    if (device.revokedAt) throw new ApiError(401, "device_revoked", "Este dispositivo fue desvinculado desde otro equipo.");
    return { deviceId: device.id, tenantId: device.tenantId };
  }

  /** Crea un dispositivo con el siguiente prefijo libre (D01, D02...). */
  async function createDevice(tx: Db, tenantId: string, name: string) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);
    const [{ count }] = rows<{ count: number }>(await tx.execute(sql`SELECT count(*)::int AS count FROM devices WHERE tenant_id = ${tenantId}`)) as [{ count: number }];
    const prefix = `D${String(count + 1).padStart(2, "0")}`;
    const token = newDeviceToken();
    const id = randomUUID();
    await tx.insert(devices).values({ id, tenantId, name, prefix, tokenHash: hashToken(token) });
    return { id, prefix, token };
  }

  const authLimit = opts.rateLimit === false ? {} : { rateLimit: { max: 10, timeWindow: "1 minute" } };

  if (opts.demo) {
    app.addHook("onSend", async (_req, reply) => {
      reply.header("X-Robots-Tag", "noindex, nofollow");
    });
  }

  app.get("/api/health", async () => ({ ok: true }));
  /** Datos públicos del servidor que la app necesita al arrancar. */
  app.get("/api/info", async () => ({ demo: Boolean(opts.demo) }));

  app.post<{ Body: { businessName: string; email: string; password: string; deviceName: string; ownerUserId?: string } }>(
    "/api/auth/register",
    {
      config: authLimit,
      schema: {
        body: {
          type: "object",
          required: ["businessName", "email", "password", "deviceName"],
          properties: {
            businessName: { type: "string", minLength: 1, maxLength: 120 },
            email: { type: "string", maxLength: 200 },
            password: { type: "string", maxLength: 200 },
            deviceName: { type: "string", minLength: 1, maxLength: 80 },
            ownerUserId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      if (!EMAIL.test(email)) throw new ApiError(400, "invalid_email", "El email no es válido.");
      if (req.body.password.length < 8) throw new ApiError(400, "weak_password", "La contraseña tiene que tener al menos 8 caracteres.");
      const [existing] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email)).limit(1);
      if (existing) throw new ApiError(409, "email_taken", "Ya existe una cuenta con ese email. Probá iniciar sesión.");
      const passwordHash = await hashPassword(req.body.password);
      const tenantId = randomUUID();
      const accountId = req.body.ownerUserId ?? randomUUID();
      const device = await db.transaction(async (tx) => {
        await tx.insert(tenants).values({ id: tenantId, name: req.body.businessName.trim() });
        await tx.insert(accounts).values({ id: accountId, tenantId, email, passwordHash });
        return createDevice(tx as unknown as Db, tenantId, req.body.deviceName.trim());
      });
      return { tenant: { id: tenantId, name: req.body.businessName.trim() }, accountId, device };
    },
  );

  app.post<{ Body: { email: string; password: string; deviceName: string } }>(
    "/api/auth/login",
    {
      config: authLimit,
      schema: {
        body: {
          type: "object",
          required: ["email", "password", "deviceName"],
          properties: {
            email: { type: "string", maxLength: 200 },
            password: { type: "string", maxLength: 200 },
            deviceName: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
    },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      const [account] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);
      if (!account || !(await verifyPassword(req.body.password, account.passwordHash))) {
        throw new ApiError(401, "bad_credentials", "El email o la contraseña no coinciden.");
      }
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, account.tenantId)).limit(1);
      const device = await db.transaction((tx) => createDevice(tx as unknown as Db, account.tenantId, req.body.deviceName.trim()));
      return { tenant: { id: tenant!.id, name: tenant!.name }, accountId: account.id, device };
    },
  );

  app.get("/api/me", async (req) => {
    const ctx = await authenticate(req);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1);
    const [device] = await db.select().from(devices).where(eq(devices.id, ctx.deviceId)).limit(1);
    return { tenant: { id: tenant!.id, name: tenant!.name }, device: { id: device!.id, name: device!.name, prefix: device!.prefix } };
  });

  // --- Dispositivos vinculados ---

  app.get("/api/devices", async (req) => {
    const ctx = await authenticate(req);
    const list = await db.select().from(devices).where(eq(devices.tenantId, ctx.tenantId)).orderBy(devices.createdAt);
    return list.map((d) => ({
      id: d.id,
      name: d.name,
      prefix: d.prefix,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      revoked: d.revokedAt !== null,
      current: d.id === ctx.deviceId,
    }));
  });

  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (req) => {
    const ctx = await authenticate(req);
    await db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.id, req.params.id), eq(devices.tenantId, ctx.tenantId), isNull(devices.revokedAt)));
    return { ok: true };
  });

  // --- Sincronización ---

  app.post<{ Body: { changes: PushChange[] } }>(
    "/api/sync/push",
    {
      schema: {
        body: {
          type: "object",
          required: ["changes"],
          properties: {
            changes: {
              type: "array",
              maxItems: MAX_PUSH,
              items: {
                type: "object",
                required: ["table", "id", "patch"],
                properties: {
                  table: { type: "string" },
                  id: { type: "string", minLength: 1, maxLength: 80 },
                  patch: { type: "object" },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const ctx = await authenticate(req);
      const changes = req.body.changes;
      for (const c of changes) {
        if (!isSyncTable(c.table)) throw new ApiError(400, "invalid_table", `Tabla desconocida: ${c.table}`);
      }
      if (!changes.length) return { seq: null };
      const lastSeq = await db.transaction(async (tx) => {
        // Serializa las escrituras de cada comercio: así el orden de `seq` coincide con el orden de commit
        // y ningún dispositivo puede saltearse un cambio al bajar "lo nuevo desde mi cursor".
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId}))`);
        let seq = 0;
        for (const c of changes) {
          // Fusión por campo: los campos que llegan pisan a los guardados, el resto se conserva.
          const result = await tx.execute(sql`
            INSERT INTO entities (tenant_id, tbl, id, data, seq, updated_at, updated_by)
            VALUES (${ctx.tenantId}, ${c.table}, ${c.id}, ${JSON.stringify(c.patch)}::jsonb, nextval('entity_seq'), now(), ${ctx.deviceId})
            ON CONFLICT (tenant_id, tbl, id) DO UPDATE
              SET data = entities.data || excluded.data, seq = excluded.seq, updated_at = now(), updated_by = excluded.updated_by
            RETURNING seq`);
          seq = Number(rows<{ seq: string | number }>(result)[0]!.seq);
        }
        return seq;
      });
      await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, ctx.deviceId));
      hub.publish(ctx.tenantId, ctx.deviceId, lastSeq);
      return { seq: lastSeq };
    },
  );

  app.get<{ Querystring: { since?: string; limit?: string } }>("/api/sync/pull", async (req) => {
    const ctx = await authenticate(req);
    const since = Math.max(0, Number(req.query.since ?? 0) || 0);
    const limit = Math.min(Math.max(1, Number(req.query.limit ?? PULL_LIMIT) || PULL_LIMIT), 1000);
    const result = rows<{ tbl: SyncTable; id: string; data: Record<string, unknown>; seq: string | number }>(
      await db.execute(sql`
        SELECT tbl, id, data, seq FROM entities
        WHERE tenant_id = ${ctx.tenantId} AND seq > ${since}
        ORDER BY seq LIMIT ${limit}`),
    );
    const changes: PulledEntity[] = result.map((r) => ({
      table: r.tbl,
      id: r.id,
      data: typeof r.data === "string" ? JSON.parse(r.data) : r.data,
      seq: Number(r.seq),
    }));
    await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, ctx.deviceId));
    return { changes, cursor: changes.at(-1)?.seq ?? since, hasMore: changes.length === limit };
  });

  /** Server-Sent Events: avisa "hay cambios" para que el dispositivo baje enseguida, sin esperar al próximo ciclo. */
  app.get("/api/sync/events", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await authenticate(req);
    reply.hijack();
    const res = reply.raw;
    const origin = req.headers.origin;
    res.writeHead(200, {
      ...(origin && allowedOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": conectado\n\n");
    const unsubscribe = hub.subscribe(ctx.tenantId, {
      deviceId: ctx.deviceId,
      send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  await registerPayments(app, {
    db,
    hub,
    authenticate,
    secrets: opts.appSecret ? new SecretBox(opts.appSecret) : null,
    mpApiUrl: opts.mpApiUrl ?? "https://api.mercadopago.com",
    publicUrl: opts.publicUrl,
    demo: opts.demo ?? false,
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: false });
  }

  return app;
}
