import { ApiError } from "../errors.ts";
import { signCms } from "./certs.ts";
import { callSoap, escapeXml, parseXml, SoapFault } from "./soap.ts";

export type ArcaEnv = "homologacion" | "produccion";

export interface ArcaUrls {
  wsaa: string;
  wsfe: string;
}

/** Direcciones oficiales (de los WSDL publicados por ARCA). */
export const ARCA_URLS: Record<ArcaEnv, ArcaUrls> = {
  homologacion: {
    wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  },
  produccion: {
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
  },
};

export interface AccessTicket {
  token: string;
  sign: string;
  expiresAt: Date;
}

/** Pedido de acceso (TRA). Se pide con unos minutos de margen hacia atrás por diferencias de reloj. */
export function buildTra(service: string, now = new Date()): string {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header>` +
    `<uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>` +
    `<generationTime>${iso(new Date(now.getTime() - 10 * 60_000))}</generationTime>` +
    `<expirationTime>${iso(new Date(now.getTime() + 10 * 60_000))}</expirationTime>` +
    `</header><service>${escapeXml(service)}</service></loginTicketRequest>`
  );
}

/** Pide a WSAA un ticket de acceso (vale ~12 horas) para un servicio, firmando con el certificado del comercio. */
export async function login(url: string, certPem: string, keyPem: string, service = "wsfe"): Promise<AccessTicket> {
  const cms = signCms(buildTra(service), certPem, keyPem);
  const envelope =
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">` +
    `<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  let body: Record<string, any>;
  try {
    body = await callSoap(url, "", envelope);
  } catch (e) {
    if (e instanceof SoapFault) throw wsaaError(e);
    throw e;
  }
  const inner = parseXml(String(body.loginCmsResponse?.loginCmsReturn ?? ""));
  const ticket = inner.loginTicketResponse;
  if (!ticket?.credentials?.token) throw new ApiError(502, "arca_wsaa", "ARCA no devolvió el ticket de acceso.");
  return {
    token: String(ticket.credentials.token),
    sign: String(ticket.credentials.sign),
    expiresAt: new Date(String(ticket.header.expirationTime)),
  };
}

function wsaaError(e: SoapFault): ApiError {
  const msg = e.message;
  if (/alreadyAuthenticated|ya posee un TA valido/i.test(msg + e.code)) {
    return new ApiError(409, "arca_ta_vigente", "ARCA dice que ya hay un acceso vigente para este certificado (por ejemplo, de otro sistema). Volvé a probar más tarde.");
  }
  if (/cms\.cert\.untrusted|cert\.expired|certificado/i.test(msg + e.code)) {
    return new ApiError(409, "arca_cert", `ARCA rechazó el certificado: ${msg}. Revisá que sea del ambiente correcto y no esté vencido.`);
  }
  if (/notAuthorized|no autorizado|coe\.notAuthorized/i.test(msg + e.code)) {
    return new ApiError(409, "arca_no_autorizado", "El certificado no está autorizado para facturar. En ARCA, asociá el servicio “Facturación electrónica” (wsfe) en el Administrador de Relaciones.");
  }
  return new ApiError(502, "arca_wsaa", `ARCA rechazó el acceso: ${msg}`);
}
