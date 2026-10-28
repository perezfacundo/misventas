import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.ts";

/** Estado de un cobro, como lo entiende la caja. */
export type ChargeStatus = "pendiente" | "pagado" | "fallido";
export type ChargeKind = "qr" | "point";

export interface MpOrderState {
  mpOrderId: string;
  mpStatus: string;
  statusDetail: string | null;
  status: ChargeStatus;
  paymentId: string | null;
  qrData: string | null;
}

/** Estados de una orden de Mercado Pago (API de Orders) → estado del cobro en la caja. */
export function toChargeStatus(mpStatus: string): ChargeStatus {
  if (mpStatus === "processed") return "pagado";
  if (["failed", "canceled", "expired", "refunded"].includes(mpStatus)) return "fallido";
  // created, at_terminal, action_required: todavía no hay resultado.
  return "pendiente";
}

export function chargeMessage(mpStatus: string): string | null {
  switch (mpStatus) {
    case "action_required":
      return "Revisá el posnet: el pago necesita una confirmación.";
    case "expired":
      return "Venció el tiempo para pagar.";
    case "canceled":
      return "Se canceló el cobro.";
    case "failed":
      return "El pago fue rechazado. Probá con otro medio.";
    case "refunded":
      return "El pago fue devuelto.";
    case "disconnected":
      return "Mercado Pago se desconectó de Mis Ventas. Revisá en la app de Mercado Pago si el pago entró.";
    default:
      return null;
  }
}

/** Montos de la API: texto con dos decimales ("1500.00"). */
export const toMpAmount = (cents: number) => (cents / 100).toFixed(2);

interface RawOrder {
  id: string;
  status: string;
  status_detail?: string;
  type_response?: { qr_data?: string };
  transactions?: { payments?: { id?: string; status?: string }[] };
}

function toState(o: RawOrder): MpOrderState {
  return {
    mpOrderId: o.id,
    mpStatus: o.status,
    statusDetail: o.status_detail ?? null,
    status: toChargeStatus(o.status),
    paymentId: o.transactions?.payments?.[0]?.id ?? null,
    qrData: o.type_response?.qr_data ?? null,
  };
}

/** Cliente mínimo de la API de Mercado Pago para cobros presenciales (QR y Point). */
export class MercadoPago {
  private baseUrl: string;
  private token: string;
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(502, "mp_unreachable", "No se pudo conectar con Mercado Pago. Probá de nuevo.");
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw mpError(res.status, data);
    return data as T;
  }

  /** Valida el token y devuelve la cuenta. */
  async me(): Promise<{ id: number; nickname?: string; site_id?: string }> {
    return this.request("GET", "/users/me");
  }

  async listPos(): Promise<{ id: number; name: string; externalId: string | null; qrImage: string | null }[]> {
    const data = await this.request<{ results?: { id: number; name: string; external_id?: string; qr?: { image?: string } }[] }>("GET", "/pos?limit=50");
    return (data.results ?? []).map((p) => ({ id: p.id, name: p.name, externalId: p.external_id || null, qrImage: p.qr?.image ?? null }));
  }

  async listTerminals(): Promise<{ id: string; operatingMode: string; externalPosId: string | null }[]> {
    const data = await this.request<{ data?: { terminals?: { id: string; operating_mode?: string; external_pos_id?: string }[] } }>(
      "GET",
      "/terminals/v1/list?limit=50",
    );
    return (data.data?.terminals ?? []).map((t) => ({ id: t.id, operatingMode: t.operating_mode ?? "", externalPosId: t.external_pos_id ?? null }));
  }

  /** El Point tiene que estar en modo PDV (integrado) para recibir cobros desde la caja. */
  async setPdvMode(terminalId: string): Promise<void> {
    await this.request("PATCH", "/terminals/v1/setup", { terminals: [{ id: terminalId, operating_mode: "PDV" }] });
  }

  /** Crea un local y su caja con QR, con ids externos propios (los que crea la app de MP no sirven para integrar). */
  async createQrPos(input: {
    userId: string;
    externalStoreId: string;
    externalPosId: string;
    storeName: string;
    location: { street_name: string; street_number: string; city_name: string; state_name: string; latitude: number; longitude: number; reference?: string };
  }): Promise<{ externalPosId: string; qrImage: string | null }> {
    await this.request("POST", `/users/${encodeURIComponent(input.userId)}/stores`, {
      name: input.storeName.slice(0, 60),
      external_id: input.externalStoreId,
      location: input.location,
    }, `${input.externalStoreId}-store`);
    const pos = await this.request<{ external_id?: string; qr?: { image?: string }; qr_response?: { image?: string } }>(
      "POST",
      "/v2/pos",
      {
        name: "Caja Mis Ventas",
        external_store_id: input.externalStoreId,
        external_id: input.externalPosId,
        config: { qr: { operating_mode: "pdv", category: 621102 } },
      },
      `${input.externalPosId}-pos`,
    );
    return { externalPosId: pos.external_id ?? input.externalPosId, qrImage: pos.qr_response?.image ?? pos.qr?.image ?? null };
  }

  async createOrder(input: {
    kind: ChargeKind;
    amount: number;
    externalReference: string;
    description: string;
    externalPosId?: string;
    terminalId?: string;
  }): Promise<MpOrderState> {
    const amount = toMpAmount(input.amount);
    const common = {
      external_reference: input.externalReference,
      description: input.description.slice(0, 150),
      expiration_time: "PT10M",
      transactions: { payments: [{ amount }] },
    };
    const body =
      input.kind === "qr"
        ? { ...common, type: "qr", total_amount: amount, config: { qr: { external_pos_id: input.externalPosId, mode: "hybrid" } } }
        : { ...common, type: "point", config: { point: { terminal_id: input.terminalId, print_on_terminal: "no_ticket" } } };
    // La clave de idempotencia es el id del cobro: reintentar nunca crea dos órdenes.
    return toState(await this.request<RawOrder>("POST", "/v1/orders", body, input.externalReference));
  }

  async getOrder(mpOrderId: string): Promise<MpOrderState> {
    return toState(await this.request<RawOrder>("GET", `/v1/orders/${encodeURIComponent(mpOrderId)}`));
  }

  async cancelOrder(mpOrderId: string, idempotencyKey: string): Promise<MpOrderState> {
    return toState(await this.request<RawOrder>("POST", `/v1/orders/${encodeURIComponent(mpOrderId)}/cancel`, undefined, idempotencyKey));
  }
}

function mpError(status: number, data: Record<string, unknown>): ApiError {
  const errors = (data.errors as { code?: string }[] | undefined) ?? [];
  const code = errors[0]?.code ?? (data.error as string | undefined) ?? "";
  if (status === 401 || status === 403) return new ApiError(502, "mp_unauthorized", "Mercado Pago rechazó el token. Revisá que sea el Access Token de producción y que no haya vencido.");
  if (code === "already_queued_order_for_terminal") return new ApiError(409, "mp_terminal_busy", "El posnet tiene otro cobro pendiente. Finalizalo o cancelalo en el posnet.");
  if (code === "pos_not_found") return new ApiError(409, "mp_pos_not_found", "No se encontró la caja QR en Mercado Pago. Revisala en Ajustes.");
  if (code === "store_pos_not_found") return new ApiError(409, "mp_store_pos_not_found", "El posnet no tiene un local o caja asociados en Mercado Pago.");
  if (code === "pos_already_exists") return new ApiError(409, "mp_pos_exists", "Ya existe una caja con ese identificador en Mercado Pago.");
  const detail = (errors[0] as { message?: string } | undefined)?.message ?? (data.message as string | undefined);
  return new ApiError(502, "mp_error", `Mercado Pago respondió con un error (${status}${code ? `: ${code}` : ""})${detail ? `: ${detail}` : "."}`);
}

/**
 * Valida la firma `x-signature` de un webhook. Manifiesto: `id:{data.id};request-id:{x-request-id};ts:{ts};`
 * (los valores que faltan se omiten; los ids de órdenes van en minúsculas). HMAC-SHA256 en hex.
 */
export function verifyWebhookSignature(opts: { secret: string; signature?: string; requestId?: string; dataId?: string }): boolean {
  if (!opts.signature) return false;
  const parts = Object.fromEntries(opts.signature.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  let manifest = "";
  if (opts.dataId) manifest += `id:${opts.dataId.toLowerCase()};`;
  if (opts.requestId) manifest += `request-id:${opts.requestId};`;
  manifest += `ts:${ts};`;
  const expected = createHmac("sha256", opts.secret).update(manifest).digest("hex");
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
