import { XMLParser } from "fast-xml-parser";
import { ApiError } from "../errors.ts";

export const escapeXml = (v: string | number) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Elemento XML con prefijo; los hijos ya vienen como XML. undefined/null se omite. */
export function el(prefix: string, name: string, value: string | number | undefined | null, raw = false): string {
  if (value === undefined || value === null) return "";
  return `<${prefix}:${name}>${raw ? value : escapeXml(value)}</${prefix}:${name}>`;
}

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  // Listas que ARCA puede mandar con uno o varios elementos.
  isArray: (name) => ["Obs", "Err", "Evt", "FECAEDetResponse", "CondicionIvaReceptor", "AlicIva", "CbteAsoc"].includes(name),
});

export const parseXml = (xml: string) => parser.parse(xml) as Record<string, any>;

export async function callSoap(url: string, action: string, envelope: string): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${action}"` },
      body: envelope,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError(502, "arca_unreachable", "No se pudo conectar con ARCA. Puede estar caído o sin internet: se reintenta solo.");
  }
  const text = await res.text();
  const parsed = parseXml(text);
  const body = parsed.Envelope?.Body;
  if (body?.Fault) {
    const fault = body.Fault;
    throw new SoapFault(String(fault.faultcode ?? ""), String(fault.faultstring ?? "Error de ARCA"));
  }
  if (!res.ok || !body) throw new ApiError(502, "arca_error", `ARCA respondió con un error (${res.status}).`);
  return body;
}

export class SoapFault extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
