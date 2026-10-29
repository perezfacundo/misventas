import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import {
  CBTE, creditNoteTypeFor, DEFAULT_IDENTIFICATION_THRESHOLD, DOC, invoiceAmounts, invoiceQrUrl, invoiceTypeFor,
  isValidCuit, requiresCuit, type InvoiceAmounts, type IssuerCondition,
} from "@misventas/core";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import { arcaConfig, arcaInvoices } from "../schema.ts";
import type { SecretBox } from "../secrets.ts";
import { certificateMatchesKey, generateKeyAndCsr, readCertificate } from "./certs.ts";
import { ARCA_URLS, login, type ArcaEnv, type ArcaUrls } from "./wsaa.ts";
import { Wsfe } from "./wsfe.ts";

interface DeviceContext {
  deviceId: string;
  tenantId: string;
}

export interface ArcaOptions {
  db: Db;
  secrets: SecretBox | null;
  authenticate: (req: FastifyRequest) => Promise<DeviceContext>;
  /** En la versión de prueba solo se permite el ambiente de homologación (sin validez fiscal). */
  demo: boolean;
  /** Direcciones de ARCA (los tests usan un ARCA falso). */
  urls?: Partial<Record<ArcaEnv, ArcaUrls>>;
}

type Config = typeof arcaConfig.$inferSelect;
type Invoice = typeof arcaInvoices.$inferSelect;

/**
 * Candado por serie dentro del proceso: dos cajas no pueden pedir el mismo número a la vez.
 * Supone un único servidor (Render, un VPS). El número se guarda antes de llamar a ARCA, así que
 * si la respuesta se pierde, el reintento consulta ese número en vez de emitir otro.
 */
class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }).catch(() => {});
    return next;
  }
}

/** Fecha de hoy en Argentina, AAAA-MM-DD (el servidor puede estar en UTC). */
export const todayInArgentina = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
const compact = (isoDate: string) => isoDate.replace(/-/g, "");
const expand = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

interface StoredAmounts extends InvoiceAmounts {
  issuer: { cuit: string; razonSocial: string; condicion: IssuerCondition; domicilio: string; iibb: string; inicioActividades: string };
}

function invoiceView(row: Invoice) {
  const amounts = row.amounts as StoredAmounts;
  return {
    id: row.id,
    saleId: row.saleId,
    kind: row.kind as "factura" | "nota_credito",
    status: row.status as "pendiente" | "autorizada" | "rechazada",
    ambiente: row.ambiente as ArcaEnv,
    cbteTipo: row.cbteTipo,
    ptoVta: row.ptoVta,
    numero: row.numero,
    fecha: row.fecha ? expand(row.fecha) : null,
    cae: row.cae,
    caeVto: row.caeVto ? expand(row.caeVto) : null,
    receiver: { docTipo: row.docTipo, docNro: row.docNro, condicion: row.condicionIvaReceptor, name: row.receiverName },
    total: row.total,
    amounts: { total: amounts.total, neto: amounts.neto, iva: amounts.iva, groups: amounts.groups },
    issuer: amounts.issuer,
    messages: row.messages as string[],
    associatedId: row.associatedId,
    qrUrl:
      row.status === "autorizada" && row.cae && row.numero && row.fecha
        ? invoiceQrUrl({
            fecha: expand(row.fecha), cuit: amounts.issuer.cuit, ptoVta: row.ptoVta, tipoCmp: row.cbteTipo, nroCmp: row.numero,
            importe: row.total, docTipo: row.docTipo, docNro: row.docNro, cae: row.cae,
          })
        : null,
  };
}

interface ReceiverInput {
  docTipo: number;
  docNro: string;
  condicion: number;
  name?: string;
}

function validateReceiver(cbteTipo: number, r: ReceiverInput, total: number): void {
  const digits = r.docNro.replace(/\D/g, "");
  if (r.docTipo === DOC.CUIT || r.docTipo === DOC.CUIL) {
    if (!isValidCuit(digits)) throw new ApiError(400, "invalid_cuit", "El CUIT del cliente no es válido.");
  } else if (r.docTipo === DOC.DNI) {
    if (!/^\d{7,8}$/.test(digits)) throw new ApiError(400, "invalid_dni", "El DNI del cliente tiene que tener 7 u 8 números.");
  } else if (r.docTipo !== DOC.CONSUMIDOR_FINAL) {
    throw new ApiError(400, "invalid_doc", "Tipo de documento no soportado.");
  }
  if (requiresCuit(cbteTipo) && r.docTipo !== DOC.CUIT) {
    throw new ApiError(400, "factura_a_cuit", "La factura A necesita el CUIT del cliente.");
  }
  if (r.docTipo === DOC.CONSUMIDOR_FINAL && total >= DEFAULT_IDENTIFICATION_THRESHOLD) {
    throw new ApiError(400, "identificacion", "Desde $10.000.000 hay que identificar al comprador con DNI o CUIT.");
  }
}

export async function registerArca(app: FastifyInstance, opts: ArcaOptions): Promise<void> {
  const { db, authenticate } = opts;
  const series = new KeyedMutex();
  const tickets = new KeyedMutex();
  const urlsFor = (env: ArcaEnv): ArcaUrls => ({ ...ARCA_URLS[env], ...opts.urls?.[env] });

  function box(): SecretBox {
    if (!opts.secrets) throw new ApiError(503, "no_app_secret", "El servidor no tiene configurada la clave APP_SECRET: no se puede guardar el certificado.");
    return opts.secrets;
  }

  async function configOf(tenantId: string): Promise<Config | undefined> {
    const [c] = await db.select().from(arcaConfig).where(eq(arcaConfig.tenantId, tenantId)).limit(1);
    return c;
  }

  async function readyConfig(tenantId: string): Promise<Config> {
    const c = await configOf(tenantId);
    if (!c) throw new ApiError(409, "arca_not_configured", "La factura electrónica no está configurada. Completala en Ajustes.");
    if (!c.keyEnc || !c.certPem) throw new ApiError(409, "arca_no_cert", "Falta cargar el certificado de ARCA en Ajustes.");
    if (c.certExpiresAt && c.certExpiresAt < new Date()) throw new ApiError(409, "arca_cert_expired", "El certificado de ARCA venció. Generá uno nuevo en Ajustes.");
    return c;
  }

  /** Ticket de acceso de WSAA: se reutiliza mientras esté vigente (ARCA no da otro hasta que venza). */
  async function wsfeFor(c: Config): Promise<Wsfe> {
    const auth = await tickets.run(c.tenantId, async () => {
      const fresh = (await configOf(c.tenantId))!;
      const valid = fresh.taTokenEnc && fresh.taSignEnc && fresh.taExpiresAt && fresh.taAmbiente === fresh.ambiente && fresh.taExpiresAt.getTime() - Date.now() > 5 * 60_000;
      if (valid) return { token: box().decrypt(fresh.taTokenEnc!), sign: box().decrypt(fresh.taSignEnc!) };
      const ta = await login(urlsFor(fresh.ambiente as ArcaEnv).wsaa, fresh.certPem!, box().decrypt(fresh.keyEnc!));
      await db
        .update(arcaConfig)
        .set({ taTokenEnc: box().encrypt(ta.token), taSignEnc: box().encrypt(ta.sign), taExpiresAt: ta.expiresAt, taAmbiente: fresh.ambiente })
        .where(eq(arcaConfig.tenantId, c.tenantId));
      return { token: ta.token, sign: ta.sign };
    });
    return new Wsfe(urlsFor(c.ambiente as ArcaEnv).wsfe, { ...auth, cuit: c.cuit });
  }

  // --- Configuración ---

  app.get("/api/arca/config", async (req) => {
    const ctx = await authenticate(req);
    const c = await configOf(ctx.tenantId);
    const certCuit = c?.certPem ? readCertificate(c.certPem).cuit : null;
    return {
      available: opts.secrets !== null,
      demo: opts.demo,
      configured: Boolean(c),
      cuit: c?.cuit ?? "",
      razonSocial: c?.razonSocial ?? "",
      condicion: (c?.condicion ?? "monotributo") as IssuerCondition,
      ptoVta: c?.ptoVta ?? 1,
      ambiente: (c?.ambiente ?? "homologacion") as ArcaEnv,
      domicilio: c?.domicilio ?? "",
      iibb: c?.iibb ?? "",
      inicioActividades: c?.inicioActividades ?? "",
      csrPem: c?.csrPem ?? null,
      hasCert: Boolean(c?.certPem),
      certExpiresAt: c?.certExpiresAt ?? null,
      certCuit,
      ready: Boolean(c?.keyEnc && c?.certPem && (!c.certExpiresAt || c.certExpiresAt > new Date())),
    };
  });

  app.put<{ Body: { cuit: string; razonSocial: string; condicion: IssuerCondition; ptoVta: number; ambiente: ArcaEnv; domicilio?: string; iibb?: string; inicioActividades?: string } }>(
    "/api/arca/config",
    {
      schema: {
        body: {
          type: "object",
          required: ["cuit", "razonSocial", "condicion", "ptoVta", "ambiente"],
          properties: {
            cuit: { type: "string", maxLength: 20 },
            razonSocial: { type: "string", minLength: 1, maxLength: 120 },
            condicion: { type: "string", enum: ["monotributo", "responsable_inscripto"] },
            ptoVta: { type: "integer", minimum: 1, maximum: 99999 },
            ambiente: { type: "string", enum: ["homologacion", "produccion"] },
            domicilio: { type: "string", maxLength: 200 },
            iibb: { type: "string", maxLength: 40 },
            inicioActividades: { type: "string", maxLength: 10 },
          },
        },
      },
    },
    async (req) => {
      const ctx = await authenticate(req);
      const b = req.body;
      const cuit = b.cuit.replace(/\D/g, "");
      if (!isValidCuit(cuit)) throw new ApiError(400, "invalid_cuit", "El CUIT no es válido.");
      if (opts.demo && b.ambiente === "produccion") {
        throw new ApiError(403, "demo", "En la versión de prueba solo se puede usar el ambiente de homologación (facturas sin validez fiscal).");
      }
      const values = {
        cuit,
        razonSocial: b.razonSocial.trim(),
        condicion: b.condicion,
        ptoVta: b.ptoVta,
        ambiente: b.ambiente,
        domicilio: b.domicilio?.trim() ?? "",
        iibb: b.iibb?.trim() ?? "",
        inicioActividades: b.inicioActividades?.trim() ?? "",
        updatedAt: new Date(),
      };
      const existing = await configOf(ctx.tenantId);
      if (!existing) {
        await db.insert(arcaConfig).values({ tenantId: ctx.tenantId, ...values });
      } else {
        // Otro CUIT invalida el certificado (está emitido a nombre del anterior).
        const reset = existing.cuit !== cuit ? { keyEnc: null, csrPem: null, certPem: null, certExpiresAt: null, taTokenEnc: null, taSignEnc: null, taExpiresAt: null } : {};
        await db.update(arcaConfig).set({ ...values, ...reset }).where(eq(arcaConfig.tenantId, ctx.tenantId));
      }
      return { ok: true };
    },
  );

  /** Genera la clave (queda en el servidor, cifrada) y el pedido de certificado para subir a ARCA. */
  app.post("/api/arca/csr", async (req) => {
    const ctx = await authenticate(req);
    const c = await configOf(ctx.tenantId);
    if (!c) throw new ApiError(409, "arca_not_configured", "Primero completá los datos fiscales.");
    const { keyPem, csrPem } = generateKeyAndCsr({ cuit: c.cuit, razonSocial: c.razonSocial });
    await db
      .update(arcaConfig)
      .set({ keyEnc: box().encrypt(keyPem), csrPem, certPem: null, certExpiresAt: null, taTokenEnc: null, taSignEnc: null, taExpiresAt: null, updatedAt: new Date() })
      .where(eq(arcaConfig.tenantId, ctx.tenantId));
    return { csrPem };
  });

  app.put<{ Body: { pem: string } }>(
    "/api/arca/certificate",
    { schema: { body: { type: "object", required: ["pem"], properties: { pem: { type: "string", minLength: 100, maxLength: 20_000 } } } } },
    async (req) => {
      const ctx = await authenticate(req);
      const c = await configOf(ctx.tenantId);
      if (!c?.keyEnc) throw new ApiError(409, "arca_no_key", "Primero generá el pedido de certificado (CSR).");
      let info;
      try {
        info = readCertificate(req.body.pem);
      } catch {
        throw new ApiError(400, "invalid_cert", "El archivo no es un certificado válido (tiene que ser el .crt que descargaste de ARCA).");
      }
      if (!certificateMatchesKey(req.body.pem, box().decrypt(c.keyEnc))) {
        throw new ApiError(400, "cert_key_mismatch", "Ese certificado no corresponde al último pedido generado acá. Subí el que ARCA emitió para este pedido.");
      }
      if (info.cuit && info.cuit !== c.cuit) throw new ApiError(400, "cert_cuit", `El certificado es del CUIT ${info.cuit}, no del configurado.`);
      if (info.notAfter < new Date()) throw new ApiError(400, "cert_expired", "Ese certificado ya venció.");
      await db
        .update(arcaConfig)
        .set({ certPem: req.body.pem.trim(), certExpiresAt: info.notAfter, taTokenEnc: null, taSignEnc: null, taExpiresAt: null, updatedAt: new Date() })
        .where(eq(arcaConfig.tenantId, ctx.tenantId));
      return { ok: true, expiresAt: info.notAfter };
    },
  );

  /** Prueba de punta a punta: acceso con el certificado y último número de cada comprobante. */
  app.post("/api/arca/test", async (req) => {
    const ctx = await authenticate(req);
    const c = await readyConfig(ctx.tenantId);
    const wsfe = await wsfeFor(c);
    const servers = await wsfe.dummy();
    const types = c.condicion === "monotributo" ? [CBTE.FACTURA_C] : [CBTE.FACTURA_B, CBTE.FACTURA_A];
    const last: Record<number, number> = {};
    for (const t of types) last[t] = await wsfe.lastAuthorized(c.ptoVta, t);
    return { ok: servers.app === "OK" && servers.db === "OK" && servers.auth === "OK", servers, last };
  });

  // --- Emisión ---

  async function emit(c: Config, row: Invoice): Promise<Invoice> {
    const wsfe = await wsfeFor(c);
    return series.run(`${c.tenantId}:${row.ptoVta}:${row.cbteTipo}`, async () => {
      let current = (await db.select().from(arcaInvoices).where(eq(arcaInvoices.id, row.id)).limit(1))[0]!;
      if (current.status !== "pendiente") return current;
      const amounts = current.amounts as StoredAmounts;
      const update = async (patch: Partial<typeof arcaInvoices.$inferInsert>) =>
        (current = (await db.update(arcaInvoices).set({ ...patch, updatedAt: new Date() }).where(eq(arcaInvoices.id, current.id)).returning())[0]!);

      // Un intento anterior quedó sin respuesta: ¿ARCA llegó a autorizarlo?
      if (current.numero) {
        const found = await wsfe.consult(current.ptoVta, current.cbteTipo, current.numero);
        if (found && Math.round(Number(found.total) * 100) === current.total) {
          return update({ status: "autorizada", cae: found.cae, caeVto: found.caeVto, messages: [] });
        }
      }

      let asociado;
      if (current.associatedId) {
        const [orig] = await db.select().from(arcaInvoices).where(eq(arcaInvoices.id, current.associatedId)).limit(1);
        asociado = { tipo: orig!.cbteTipo, ptoVta: orig!.ptoVta, numero: orig!.numero!, cuit: c.cuit, fecha: orig!.fecha! };
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const numero = (await wsfe.lastAuthorized(current.ptoVta, current.cbteTipo)) + 1;
        const fecha = compact(todayInArgentina());
        await update({ numero, fecha });
        const result = await wsfe.requestCae({
          ptoVta: current.ptoVta,
          cbteTipo: current.cbteTipo,
          numero,
          fecha,
          docTipo: current.docTipo,
          docNro: current.docNro,
          condicionIvaReceptor: current.condicionIvaReceptor,
          amounts,
          asociado,
        });
        if (result.resultado === "A") return update({ status: "autorizada", cae: result.cae, caeVto: result.caeVto, messages: result.messages });
        // 10016: el número no es el próximo (otra emisión lo tomó por fuera de Mis Ventas): se pide de nuevo.
        if (attempt === 0 && result.errorCodes.includes(10016)) continue;
        return update({ status: "rechazada", numero: null, messages: result.messages.length ? result.messages : ["ARCA rechazó el comprobante."] });
      }
      return current;
    });
  }

  async function existingFor(tenantId: string, id: string) {
    const [byId] = await db.select().from(arcaInvoices).where(and(eq(arcaInvoices.id, id), eq(arcaInvoices.tenantId, tenantId))).limit(1);
    return byId;
  }

  app.post<{
    Body: { id: string; saleId: string; lines: { gross: number; ivaRate?: number }[]; discount?: number; receiver: ReceiverInput };
  }>(
    "/api/arca/invoices",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "saleId", "lines", "receiver"],
          properties: {
            id: { type: "string", format: "uuid" },
            saleId: { type: "string", minLength: 1, maxLength: 80 },
            discount: { type: "integer", minimum: 0 },
            lines: {
              type: "array",
              minItems: 1,
              maxItems: 500,
              items: { type: "object", required: ["gross"], properties: { gross: { type: "integer", minimum: 0 }, ivaRate: { type: "number" } } },
            },
            receiver: {
              type: "object",
              required: ["docTipo", "docNro", "condicion"],
              properties: {
                docTipo: { type: "integer" },
                docNro: { type: "string", maxLength: 20 },
                condicion: { type: "integer" },
                name: { type: "string", maxLength: 120 },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const ctx = await authenticate(req);
      const b = req.body;
      let row = await existingFor(ctx.tenantId, b.id);
      if (!row) {
        // Una venta tiene una sola factura vigente: si ya hay otra (de otro intento), se devuelve esa.
        const [other] = await db
          .select()
          .from(arcaInvoices)
          .where(and(eq(arcaInvoices.tenantId, ctx.tenantId), eq(arcaInvoices.saleId, b.saleId), eq(arcaInvoices.kind, "factura"), ne(arcaInvoices.status, "rechazada")))
          .limit(1);
        if (other) row = other;
      }
      const c = await readyConfig(ctx.tenantId);
      if (!row) {
        const cbteTipo = invoiceTypeFor(c.condicion as IssuerCondition, b.receiver.condicion);
        const amounts = invoiceAmounts(cbteTipo, b.lines, b.discount ?? 0);
        if (amounts.total <= 0) throw new ApiError(400, "zero", "No se puede facturar una venta en $0.");
        validateReceiver(cbteTipo, b.receiver, amounts.total);
        const stored: StoredAmounts = {
          ...amounts,
          issuer: { cuit: c.cuit, razonSocial: c.razonSocial, condicion: c.condicion as IssuerCondition, domicilio: c.domicilio, iibb: c.iibb, inicioActividades: c.inicioActividades },
        };
        [row] = await db
          .insert(arcaInvoices)
          .values({
            id: b.id,
            tenantId: ctx.tenantId,
            saleId: b.saleId,
            kind: "factura",
            status: "pendiente",
            ambiente: c.ambiente,
            cbteTipo,
            ptoVta: c.ptoVta,
            docTipo: b.receiver.docTipo,
            docNro: b.receiver.docNro.replace(/\D/g, "") || "0",
            condicionIvaReceptor: b.receiver.condicion,
            receiverName: b.receiver.name?.trim() || null,
            total: amounts.total,
            amounts: stored,
            messages: [],
          })
          .returning();
      }
      return invoiceView(await emit(c, row!));
    },
  );

  app.post<{ Params: { id: string }; Body: { id: string } }>(
    "/api/arca/invoices/:id/credit-note",
    { schema: { body: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } } },
    async (req) => {
      const ctx = await authenticate(req);
      const original = await existingFor(ctx.tenantId, req.params.id);
      if (!original || original.kind !== "factura") throw new ApiError(404, "not_found", "No se encontró la factura.");
      if (original.status !== "autorizada") throw new ApiError(409, "not_authorized", "Solo se puede anular con nota de crédito una factura autorizada.");
      const c = await readyConfig(ctx.tenantId);
      let row = await existingFor(ctx.tenantId, req.body.id);
      if (!row) {
        const [other] = await db
          .select()
          .from(arcaInvoices)
          .where(and(eq(arcaInvoices.tenantId, ctx.tenantId), eq(arcaInvoices.associatedId, original.id), ne(arcaInvoices.status, "rechazada")))
          .limit(1);
        row = other;
      }
      if (!row) {
        [row] = await db
          .insert(arcaInvoices)
          .values({
            ...original,
            id: req.body.id,
            kind: "nota_credito",
            status: "pendiente",
            cbteTipo: creditNoteTypeFor(original.cbteTipo),
            numero: null,
            fecha: null,
            cae: null,
            caeVto: null,
            messages: [],
            associatedId: original.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning();
      }
      return invoiceView(await emit(c, row!));
    },
  );

  app.get<{ Params: { id: string } }>("/api/arca/invoices/:id", async (req) => {
    const ctx = await authenticate(req);
    const row = await existingFor(ctx.tenantId, req.params.id);
    if (!row) throw new ApiError(404, "not_found", "No se encontró el comprobante.");
    return invoiceView(row);
  });
}
