import { arcaAmount, IVA_ID, type InvoiceAmounts } from "@misventas/core";
import { ApiError } from "../errors.ts";
import { callSoap, el, SoapFault } from "./soap.ts";

const NS = "http://ar.gov.afip.dif.FEV1/";

export interface WsfeAuth {
  token: string;
  sign: string;
  cuit: string;
}

export interface CaeRequest {
  ptoVta: number;
  cbteTipo: number;
  numero: number;
  /** AAAAMMDD */
  fecha: string;
  docTipo: number;
  docNro: string;
  condicionIvaReceptor: number;
  amounts: InvoiceAmounts;
  /** Para notas de crédito: el comprobante que anulan. */
  asociado?: { tipo: number; ptoVta: number; numero: number; cuit: string; fecha: string };
}

export interface CaeResult {
  resultado: "A" | "R";
  cae: string | null;
  caeVto: string | null;
  /** Errores y observaciones de ARCA, listos para mostrar. */
  messages: string[];
  /** Códigos de error (para reaccionar, por ejemplo, a un número fuera de secuencia). */
  errorCodes: number[];
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : v ? [v] : []);
const msgs = (node: any, key: string) => list(node?.[key]).map((x: any) => `${x.Code}: ${x.Msg}`);

/** Cliente del web service de factura electrónica (WSFEv1). Los elementos van en el orden exacto del WSDL. */
export class Wsfe {
  private url: string;
  private auth: WsfeAuth;
  constructor(url: string, auth: WsfeAuth) {
    this.url = url;
    this.auth = auth;
  }

  private authXml() {
    return `<ar:Auth>${el("ar", "Token", this.auth.token)}${el("ar", "Sign", this.auth.sign)}${el("ar", "Cuit", this.auth.cuit.replace(/\D/g, ""))}</ar:Auth>`;
  }

  private async call(op: string, inner: string): Promise<Record<string, any>> {
    const envelope =
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">` +
      `<soapenv:Header/><soapenv:Body><ar:${op}>${inner}</ar:${op}></soapenv:Body></soapenv:Envelope>`;
    try {
      const body = await callSoap(this.url, `${NS}${op}`, envelope);
      return body[`${op}Response`]?.[`${op}Result`] ?? {};
    } catch (e) {
      if (e instanceof SoapFault) throw new ApiError(502, "arca_wsfe", `ARCA rechazó el pedido: ${e.message}`);
      throw e;
    }
  }

  /** Estado de los servidores de ARCA (no requiere autenticación). */
  async dummy(): Promise<{ app: string; db: string; auth: string }> {
    const r = await this.call("FEDummy", "");
    return { app: String(r.AppServer ?? ""), db: String(r.DbServer ?? ""), auth: String(r.AuthServer ?? "") };
  }

  async lastAuthorized(ptoVta: number, cbteTipo: number): Promise<number> {
    const r = await this.call("FECompUltimoAutorizado", `${this.authXml()}${el("ar", "PtoVta", ptoVta)}${el("ar", "CbteTipo", cbteTipo)}`);
    const errors = msgs(r.Errors, "Err");
    if (errors.length) throw new ApiError(502, "arca_wsfe", `ARCA: ${errors.join(" · ")}`);
    return Number(r.CbteNro ?? 0);
  }

  async requestCae(req: CaeRequest): Promise<CaeResult> {
    const a = req.amounts;
    const asoc = req.asociado
      ? el("ar", "CbtesAsoc", `<ar:CbteAsoc>${el("ar", "Tipo", req.asociado.tipo)}${el("ar", "PtoVta", req.asociado.ptoVta)}${el("ar", "Nro", req.asociado.numero)}${el("ar", "Cuit", req.asociado.cuit.replace(/\D/g, ""))}${el("ar", "CbteFch", req.asociado.fecha)}</ar:CbteAsoc>`, true)
      : "";
    const iva = a.groups.length
      ? el("ar", "Iva", a.groups.map((g) => `<ar:AlicIva>${el("ar", "Id", IVA_ID[g.rate])}${el("ar", "BaseImp", arcaAmount(g.base))}${el("ar", "Importe", arcaAmount(g.iva))}</ar:AlicIva>`).join(""), true)
      : "";
    const det =
      el("ar", "Concepto", 1) + // 1 = productos
      el("ar", "DocTipo", req.docTipo) +
      el("ar", "DocNro", req.docNro.replace(/\D/g, "") || "0") +
      el("ar", "CbteDesde", req.numero) +
      el("ar", "CbteHasta", req.numero) +
      el("ar", "CbteFch", req.fecha) +
      el("ar", "ImpTotal", arcaAmount(a.total)) +
      el("ar", "ImpTotConc", "0.00") +
      el("ar", "ImpNeto", arcaAmount(a.neto)) +
      el("ar", "ImpOpEx", "0.00") +
      el("ar", "ImpTrib", "0.00") +
      el("ar", "ImpIVA", arcaAmount(a.iva)) +
      el("ar", "MonId", "PES") +
      el("ar", "MonCotiz", 1) +
      el("ar", "CondicionIVAReceptorId", req.condicionIvaReceptor) +
      asoc +
      iva;
    const inner =
      this.authXml() +
      `<ar:FeCAEReq><ar:FeCabReq>${el("ar", "CantReg", 1)}${el("ar", "PtoVta", req.ptoVta)}${el("ar", "CbteTipo", req.cbteTipo)}</ar:FeCabReq>` +
      `<ar:FeDetReq><ar:FECAEDetRequest>${det}</ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>`;
    const r = await this.call("FECAESolicitar", inner);
    const detResp = list(r.FeDetResp?.FECAEDetResponse)[0];
    const errors = list(r.Errors?.Err);
    const result = (detResp?.Resultado ?? r.FeCabResp?.Resultado) === "A" ? "A" : "R";
    return {
      resultado: result,
      cae: result === "A" && detResp?.CAE ? String(detResp.CAE) : null,
      caeVto: result === "A" && detResp?.CAEFchVto ? String(detResp.CAEFchVto) : null,
      messages: [...errors.map((x: any) => `${x.Code}: ${x.Msg}`), ...msgs(detResp?.Observaciones, "Obs")],
      errorCodes: errors.map((x: any) => Number(x.Code)),
    };
  }

  /** Consulta un comprobante ya emitido (para recuperar uno cuya respuesta se perdió). */
  async consult(ptoVta: number, cbteTipo: number, numero: number): Promise<{ cae: string; caeVto: string; total: string; docNro: string } | null> {
    const r = await this.call(
      "FECompConsultar",
      `${this.authXml()}<ar:FeCompConsReq>${el("ar", "CbteTipo", cbteTipo)}${el("ar", "CbteNro", numero)}${el("ar", "PtoVta", ptoVta)}</ar:FeCompConsReq>`,
    );
    const g = r.ResultGet;
    if (!g || g.Resultado !== "A") return null;
    return { cae: String(g.CodAutorizacion), caeVto: String(g.FchVto), total: String(g.ImpTotal), docNro: String(g.DocNro) };
  }
}
