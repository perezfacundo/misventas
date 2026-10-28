import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { rows } from "./db.ts";
import { ApiError } from "./errors.ts";
import { chargeMessage, MercadoPago, verifyWebhookSignature, type ChargeKind, type MpOrderState } from "./mercadopago.ts";
import { mpAccounts, mpCharges, tenants } from "./schema.ts";
import type { SecretBox } from "./secrets.ts";
import type { SyncHub } from "./events.ts";

interface DeviceContext {
  deviceId: string;
  tenantId: string;
}

export interface PaymentsOptions {
  db: Db;
  hub: SyncHub;
  /** null si el servidor no tiene APP_SECRET: no se pueden guardar tokens. */
  secrets: SecretBox | null;
  mpApiUrl: string;
  publicUrl?: string;
  /** En la versión de prueba no se puede conectar una cuenta de Mercado Pago. */
  demo: boolean;
  authenticate: (req: FastifyRequest) => Promise<DeviceContext>;
}

type Charge = typeof mpCharges.$inferSelect;

/** Lo que ve la caja de un cobro. */
function chargeView(c: Charge) {
  return {
    id: c.id,
    kind: c.kind as ChargeKind,
    amount: c.amount,
    status: c.status,
    mpStatus: c.mpStatus,
    paymentId: c.paymentId,
    qrData: c.qrData,
    message: chargeMessage(c.mpStatus),
  };
}

/** Rutas de Mercado Pago: configuración de la cuenta, cobros QR/Point y webhook. */
export async function registerPayments(app: FastifyInstance, opts: PaymentsOptions): Promise<void> {
  const { db, hub, authenticate } = opts;

  function assertNotDemo(): void {
    if (opts.demo) throw new ApiError(403, "demo", "En la versión de prueba no se puede conectar Mercado Pago.");
  }

  function box(): SecretBox {
    if (!opts.secrets) throw new ApiError(503, "no_app_secret", "El servidor no tiene configurada la clave APP_SECRET: no se puede conectar Mercado Pago.");
    return opts.secrets;
  }

  async function accountOf(tenantId: string) {
    const [acc] = await db.select().from(mpAccounts).where(eq(mpAccounts.tenantId, tenantId)).limit(1);
    return acc;
  }

  async function clientOf(tenantId: string): Promise<{ mp: MercadoPago; acc: typeof mpAccounts.$inferSelect }> {
    const acc = await accountOf(tenantId);
    if (!acc) throw new ApiError(409, "mp_not_connected", "Mercado Pago no está conectado. Configuralo en Ajustes.");
    return { mp: new MercadoPago(opts.mpApiUrl, box().decrypt(acc.accessTokenEnc)), acc };
  }

  async function saveState(charge: Charge, state: MpOrderState): Promise<Charge> {
    const [updated] = await db
      .update(mpCharges)
      .set({
        mpStatus: state.mpStatus,
        status: state.status,
        statusDetail: state.statusDetail,
        paymentId: state.paymentId ?? charge.paymentId,
        qrData: state.qrData ?? charge.qrData,
        updatedAt: new Date(),
      })
      .where(eq(mpCharges.id, charge.id))
      .returning();
    if (updated!.status !== charge.status || updated!.mpStatus !== charge.mpStatus) {
      hub.emit(charge.tenantId, "payment", chargeView(updated!));
    }
    return updated!;
  }

  /** Trae el estado real desde Mercado Pago si el cobro sigue pendiente (como mucho cada 2 segundos). */
  async function refresh(charge: Charge, force = false): Promise<Charge> {
    if (charge.status !== "pendiente") return charge;
    if (!force && Date.now() - charge.updatedAt.getTime() < 2000) return charge;
    if (!(await accountOf(charge.tenantId))) {
      // Se desconectó la cuenta con el cobro en curso: ya no se puede consultar, la caja deja de esperar.
      return saveState(charge, { mpOrderId: charge.mpOrderId, mpStatus: "disconnected", statusDetail: null, status: "fallido", paymentId: null, qrData: null });
    }
    const { mp } = await clientOf(charge.tenantId);
    return saveState(charge, await mp.getOrder(charge.mpOrderId));
  }

  async function chargeOf(ctx: DeviceContext, id: string): Promise<Charge> {
    const [charge] = await db.select().from(mpCharges).where(and(eq(mpCharges.id, id), eq(mpCharges.tenantId, ctx.tenantId))).limit(1);
    if (!charge) throw new ApiError(404, "not_found", "No se encontró el cobro.");
    return charge;
  }

  // --- Configuración ---

  app.get("/api/mp/config", async (req) => {
    const ctx = await authenticate(req);
    const acc = await accountOf(ctx.tenantId);
    return {
      available: opts.secrets !== null && !opts.demo,
      demo: opts.demo,
      connected: Boolean(acc),
      nickname: acc?.nickname ?? null,
      externalPosId: acc?.externalPosId ?? null,
      terminalId: acc?.terminalId ?? null,
      hasWebhookSecret: Boolean(acc?.webhookSecretEnc),
      webhookUrl: opts.publicUrl ? `${opts.publicUrl.replace(/\/$/, "")}/api/webhooks/mercadopago` : null,
    };
  });

  app.put<{ Body: { accessToken?: string; externalPosId?: string | null; terminalId?: string | null; webhookSecret?: string | null } }>(
    "/api/mp/config",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            accessToken: { type: "string", minLength: 10, maxLength: 300 },
            externalPosId: { type: ["string", "null"], maxLength: 100 },
            terminalId: { type: ["string", "null"], maxLength: 100 },
            webhookSecret: { type: ["string", "null"], maxLength: 300 },
          },
        },
      },
    },
    async (req) => {
      const ctx = await authenticate(req);
      assertNotDemo();
      const b = req.body;
      const existing = await accountOf(ctx.tenantId);
      if (b.accessToken) {
        // Antes de guardar, se valida el token con Mercado Pago.
        const me = await new MercadoPago(opts.mpApiUrl, b.accessToken.trim()).me();
        const values = {
          accessTokenEnc: box().encrypt(b.accessToken.trim()),
          mpUserId: String(me.id),
          nickname: me.nickname ?? null,
          updatedAt: new Date(),
        };
        if (existing) await db.update(mpAccounts).set(values).where(eq(mpAccounts.tenantId, ctx.tenantId));
        else await db.insert(mpAccounts).values({ tenantId: ctx.tenantId, ...values });
      } else if (!existing) {
        throw new ApiError(400, "token_required", "Pegá el Access Token de Mercado Pago.");
      }
      const patch: Partial<typeof mpAccounts.$inferInsert> = { updatedAt: new Date() };
      if (b.externalPosId !== undefined) patch.externalPosId = b.externalPosId || null;
      if (b.terminalId !== undefined) patch.terminalId = b.terminalId || null;
      if (b.webhookSecret !== undefined) patch.webhookSecretEnc = b.webhookSecret ? box().encrypt(b.webhookSecret.trim()) : null;
      await db.update(mpAccounts).set(patch).where(eq(mpAccounts.tenantId, ctx.tenantId));
      return { ok: true };
    },
  );

  app.delete("/api/mp/config", async (req) => {
    const ctx = await authenticate(req);
    await db.delete(mpAccounts).where(eq(mpAccounts.tenantId, ctx.tenantId));
    return { ok: true };
  });

  app.get("/api/mp/pos", async (req) => {
    const ctx = await authenticate(req);
    return (await clientOf(ctx.tenantId)).mp.listPos();
  });

  app.get("/api/mp/terminals", async (req) => {
    const ctx = await authenticate(req);
    return (await clientOf(ctx.tenantId)).mp.listTerminals();
  });

  app.post<{ Params: { id: string } }>("/api/mp/terminals/:id/pdv", async (req) => {
    const ctx = await authenticate(req);
    await (await clientOf(ctx.tenantId)).mp.setPdvMode(req.params.id);
    return { ok: true };
  });

  app.post<{ Body: { storeName: string; streetName: string; streetNumber: string; city: string; state: string; latitude: number; longitude: number } }>(
    "/api/mp/qr-setup",
    {
      schema: {
        body: {
          type: "object",
          required: ["storeName", "streetName", "streetNumber", "city", "state", "latitude", "longitude"],
          properties: {
            storeName: { type: "string", minLength: 1, maxLength: 60 },
            streetName: { type: "string", minLength: 1, maxLength: 100 },
            streetNumber: { type: "string", minLength: 1, maxLength: 10 },
            city: { type: "string", minLength: 1, maxLength: 80 },
            state: { type: "string", minLength: 1, maxLength: 80 },
            latitude: { type: "number", minimum: -90, maximum: 90 },
            longitude: { type: "number", minimum: -180, maximum: 180 },
          },
        },
      },
    },
    async (req) => {
      const ctx = await authenticate(req);
      const { mp, acc } = await clientOf(ctx.tenantId);
      const b = req.body;
      // Ids alfanuméricos y estables por comercio: reintentar no crea cajas duplicadas.
      const suffix = ctx.tenantId.replace(/-/g, "").slice(0, 12).toUpperCase();
      const result = await mp.createQrPos({
        userId: acc.mpUserId,
        externalStoreId: `MV${suffix}`,
        externalPosId: `MV${suffix}CAJA1`,
        storeName: b.storeName,
        location: {
          street_name: b.streetName,
          street_number: b.streetNumber,
          city_name: b.city,
          state_name: b.state,
          latitude: b.latitude,
          longitude: b.longitude,
          reference: b.storeName,
        },
      });
      await db.update(mpAccounts).set({ externalPosId: result.externalPosId, updatedAt: new Date() }).where(eq(mpAccounts.tenantId, ctx.tenantId));
      return result;
    },
  );

  // --- Cobros ---

  app.post<{ Body: { kind: ChargeKind; amount: number; id?: string } }>(
    "/api/mp/charges",
    {
      schema: {
        body: {
          type: "object",
          required: ["kind", "amount"],
          properties: {
            kind: { type: "string", enum: ["qr", "point"] },
            amount: { type: "integer", minimum: 1, maximum: 100_000_000_00 },
            id: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (req) => {
      const ctx = await authenticate(req);
      const { mp, acc } = await clientOf(ctx.tenantId);
      const { kind, amount } = req.body;
      if (kind === "qr" && !acc.externalPosId) throw new ApiError(409, "mp_no_pos", "Falta elegir la caja QR de Mercado Pago en Ajustes.");
      if (kind === "point" && !acc.terminalId) throw new ApiError(409, "mp_no_terminal", "Falta elegir el posnet Point en Ajustes.");
      // El id lo puede mandar la caja: si reintenta tras un corte, no se crea un segundo cobro.
      const id = req.body.id ?? randomUUID();
      const [existing] = await db.select().from(mpCharges).where(and(eq(mpCharges.id, id), eq(mpCharges.tenantId, ctx.tenantId))).limit(1);
      if (existing) return chargeView(existing);
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1);
      const state = await mp.createOrder({
        kind,
        amount,
        externalReference: id,
        description: `Compra en ${tenant?.name ?? "el kiosco"}`,
        externalPosId: acc.externalPosId ?? undefined,
        terminalId: acc.terminalId ?? undefined,
      });
      const [charge] = await db
        .insert(mpCharges)
        .values({
          id,
          tenantId: ctx.tenantId,
          deviceId: ctx.deviceId,
          kind,
          amount,
          mpOrderId: state.mpOrderId,
          mpStatus: state.mpStatus,
          status: state.status,
          statusDetail: state.statusDetail,
          paymentId: state.paymentId,
          qrData: state.qrData,
        })
        .returning();
      return chargeView(charge!);
    },
  );

  app.get<{ Params: { id: string } }>("/api/mp/charges/:id", async (req) => {
    const ctx = await authenticate(req);
    return chargeView(await refresh(await chargeOf(ctx, req.params.id)));
  });

  app.post<{ Params: { id: string } }>("/api/mp/charges/:id/cancel", async (req) => {
    const ctx = await authenticate(req);
    const charge = await refresh(await chargeOf(ctx, req.params.id), true);
    if (charge.status !== "pendiente") return chargeView(charge);
    const { mp } = await clientOf(ctx.tenantId);
    try {
      return chargeView(await saveState(charge, await mp.cancelOrder(charge.mpOrderId, `${charge.id}-cancel`)));
    } catch (e) {
      // Si ya llegó al posnet, solo se puede cancelar desde el aparato.
      if (charge.kind === "point" && charge.mpStatus === "at_terminal") {
        throw new ApiError(409, "mp_cancel_at_terminal", "El cobro ya está en el posnet: cancelalo desde el aparato.");
      }
      throw e;
    }
  });

  // --- Webhook ---

  /**
   * Mercado Pago avisa que una orden cambió. No se confía en el contenido (las notificaciones de QR
   * no se pueden firmar): se usa solo como aviso y el estado real se consulta a la API con el token del comercio.
   */
  app.post<{ Body: { data?: { id?: string }; user_id?: number | string; type?: string }; Querystring: { "data.id"?: string } }>(
    "/api/webhooks/mercadopago",
    async (req, reply) => {
      const dataId = req.body?.data?.id ?? req.query["data.id"];
      if (!dataId || (req.body?.type && req.body.type !== "order")) return reply.status(200).send({ ok: true });
      const found = rows<Charge & { tenant_id: string; id: string }>(
        await db.execute(sql`SELECT id, tenant_id FROM mp_charges WHERE lower(mp_order_id) = lower(${dataId}) LIMIT 1`),
      )[0];
      if (!found) return reply.status(200).send({ ok: true });
      const acc = await accountOf(found.tenant_id);
      if (acc?.webhookSecretEnc && opts.secrets) {
        const ok = verifyWebhookSignature({
          secret: opts.secrets.decrypt(acc.webhookSecretEnc),
          signature: req.headers["x-signature"] as string | undefined,
          requestId: req.headers["x-request-id"] as string | undefined,
          dataId,
        });
        if (!ok && req.headers["x-signature"]) return reply.status(401).send({ error: "invalid_signature" });
      }
      const [charge] = await db.select().from(mpCharges).where(eq(mpCharges.id, found.id)).limit(1);
      try {
        await refresh(charge!, true);
      } catch (e) {
        req.log.warn({ err: e }, "No se pudo actualizar el cobro desde el webhook");
      }
      return reply.status(200).send({ ok: true });
    },
  );
}
