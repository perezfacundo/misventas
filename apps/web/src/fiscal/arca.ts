import type { IssuerCondition } from "@misventas/core";
import { api, getCloudLink } from "../sync/engine";

export interface ArcaConfig {
  available: boolean;
  demo: boolean;
  configured: boolean;
  cuit: string;
  razonSocial: string;
  condicion: IssuerCondition;
  ptoVta: number;
  ambiente: "homologacion" | "produccion";
  domicilio: string;
  iibb: string;
  inicioActividades: string;
  csrPem: string | null;
  hasCert: boolean;
  certExpiresAt: string | null;
  certCuit: string | null;
  ready: boolean;
}

export type ArcaConfigInput = Pick<ArcaConfig, "cuit" | "razonSocial" | "condicion" | "ptoVta" | "ambiente" | "domicilio" | "iibb" | "inicioActividades">;

async function token(): Promise<string> {
  const cloud = await getCloudLink();
  if (!cloud) throw new Error("Para facturar, este dispositivo tiene que estar conectado a la nube.");
  return cloud.token;
}
const call = async <T>(path: string, init: RequestInit = {}) => api<T>(path, init, await token());

export const getArcaConfig = () => call<ArcaConfig>("/api/arca/config");
export const saveArcaConfig = (body: ArcaConfigInput) => call<{ ok: true }>("/api/arca/config", { method: "PUT", body: JSON.stringify(body) });
export const generateCsr = () => call<{ csrPem: string }>("/api/arca/csr", { method: "POST" });
export const uploadCertificate = (pem: string) => call<{ ok: true; expiresAt: string }>("/api/arca/certificate", { method: "PUT", body: JSON.stringify({ pem }) });
export const testArca = () => call<{ ok: boolean; servers: Record<string, string>; last: Record<string, number> }>("/api/arca/test", { method: "POST" });
