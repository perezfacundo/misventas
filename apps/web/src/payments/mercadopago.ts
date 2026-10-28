import { useEffect, useState } from "react";
import type { Cents, PaymentProvider } from "@misventas/core";
import { api, getCloudLink, PAYMENT_EVENT } from "../sync/engine";

export type ChargeKind = "qr" | "point";

/** Un cobro de Mercado Pago tal como lo devuelve el servidor. */
export interface Charge {
  id: string;
  kind: ChargeKind;
  amount: Cents;
  status: "pendiente" | "pagado" | "fallido";
  mpStatus: string;
  paymentId: string | null;
  qrData: string | null;
  message: string | null;
}

export interface MpConfig {
  available: boolean;
  /** Versión de prueba pública: Mercado Pago no se puede conectar. */
  demo: boolean;
  connected: boolean;
  nickname: string | null;
  externalPosId: string | null;
  terminalId: string | null;
  hasWebhookSecret: boolean;
  webhookUrl: string | null;
}

export const providerOf = (kind: ChargeKind): PaymentProvider => (kind === "qr" ? "mp_qr" : "mp_point");

async function token(): Promise<string> {
  const cloud = await getCloudLink();
  if (!cloud) throw new Error("Para usar Mercado Pago, este dispositivo tiene que estar conectado a la nube.");
  return cloud.token;
}

const call = async <T>(path: string, init: RequestInit = {}) => api<T>(path, init, await token());

export const getMpConfig = () => call<MpConfig>("/api/mp/config");
export const saveMpConfig = (body: { accessToken?: string; externalPosId?: string | null; terminalId?: string | null; webhookSecret?: string | null }) =>
  call<{ ok: true }>("/api/mp/config", { method: "PUT", body: JSON.stringify(body) });
export const disconnectMp = () => call<{ ok: true }>("/api/mp/config", { method: "DELETE" });
export const listMpPos = () => call<{ id: number; name: string; externalId: string | null; qrImage: string | null }[]>("/api/mp/pos");
export const listMpTerminals = () => call<{ id: string; operatingMode: string; externalPosId: string | null }[]>("/api/mp/terminals");
export const createQrPos = (body: { storeName: string; streetName: string; streetNumber: string; city: string; state: string; latitude: number; longitude: number }) =>
  call<{ externalPosId: string; qrImage: string | null }>("/api/mp/qr-setup", { method: "POST", body: JSON.stringify(body) });
export const setTerminalPdv = (id: string) => call<{ ok: true }>(`/api/mp/terminals/${encodeURIComponent(id)}/pdv`, { method: "POST" });

export const createCharge = (input: { id: string; kind: ChargeKind; amount: Cents }) =>
  call<Charge>("/api/mp/charges", { method: "POST", body: JSON.stringify(input) });
export const getCharge = (id: string) => call<Charge>(`/api/mp/charges/${id}`);
export const cancelCharge = (id: string) => call<Charge>(`/api/mp/charges/${id}/cancel`, { method: "POST" });

/** Qué cobros integrados se pueden ofrecer en este dispositivo. null mientras carga o si no hay nube. */
export function useMpAvailability(): { qr: boolean; point: boolean } | null {
  const [value, setValue] = useState<{ qr: boolean; point: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!(await getCloudLink())) return;
      try {
        const c = await getMpConfig();
        if (!cancelled) setValue({ qr: c.connected && Boolean(c.externalPosId), point: c.connected && Boolean(c.terminalId) });
      } catch {
        if (!cancelled) setValue({ qr: false, point: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}

/** Sigue un cobro pendiente: consulta cada 2,5 s y además escucha el aviso en tiempo real del servidor. */
export function watchCharge(id: string, onUpdate: (c: Charge) => void): () => void {
  let stopped = false;
  const tick = async () => {
    try {
      const c = await getCharge(id);
      if (!stopped) onUpdate(c);
    } catch {
      // Sin conexión momentánea: se reintenta en el próximo ciclo.
    }
  };
  const interval = setInterval(tick, 2500);
  const onEvent = (e: Event) => {
    const c = (e as CustomEvent<Charge>).detail;
    if (c.id === id && !stopped) onUpdate(c);
  };
  window.addEventListener(PAYMENT_EVENT, onEvent);
  return () => {
    stopped = true;
    clearInterval(interval);
    window.removeEventListener(PAYMENT_EVENT, onEvent);
  };
}

// --- Cobro en curso guardado localmente, por si la app se cierra mientras el cliente paga ---

const PENDING_KEY = "misventas:mp-cobro";

export function rememberCharge(charge: Charge): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(charge));
  } catch {
    // Sin localStorage no hay recuperación, pero el cobro sigue normalmente.
  }
}

export function forgetCharge(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nada que hacer.
  }
}

export function rememberedCharge(): Charge | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as Charge) : null;
  } catch {
    return null;
  }
}
