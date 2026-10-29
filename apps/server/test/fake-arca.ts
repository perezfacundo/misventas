/**
 * ARCA falso para tests: WSAA (loginCms) y WSFEv1 (FEDummy, FECompUltimoAutorizado, FECAESolicitar, FECompConsultar),
 * con las validaciones que más importan: número correlativo, sumas, condición IVA del receptor, IVA en la C,
 * comprobante asociado en notas de crédito, orden de los campos y ticket de acceso único por certificado.
 * También firma pedidos de certificado (CSR) con una CA propia, como haría ARCA.
 */
import Fastify from "fastify";
import forge from "node-forge";
import { openCms } from "../src/arca/certs.ts";
import { parseXml } from "../src/arca/soap.ts";

/** Orden de FECAEDetRequest según el WSDL oficial. */
const DET_ORDER = [
  "Concepto", "DocTipo", "DocNro", "CbteDesde", "CbteHasta", "CbteFch", "ImpTotal", "ImpTotConc", "ImpNeto", "ImpOpEx", "ImpTrib",
  "ImpIVA", "FchServDesde", "FchServHasta", "FchVtoPago", "MonId", "MonCotiz", "CanMisMonExt", "CondicionIVAReceptorId", "CbtesAsoc",
  "Tributos", "Iva", "Opcionales", "Compradores", "PeriodoAsoc", "Actividades",
];

interface Comp {
  tipo: number;
  ptoVta: number;
  numero: number;
  total: string;
  docNro: string;
  cae: string;
  caeVto: string;
  fecha: string;
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : v ? [v] : []);
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const soap = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
const fault = (code: string, msg: string) => soap(`<soap:Fault><faultcode>${code}</faultcode><faultstring>${xmlEscape(msg)}</faultstring></soap:Fault>`);

export async function startFakeArca(options: { port?: number } = {}) {
  // CA propia: firma los certificados de los comercios.
  const caKeys = forge.pki.rsa.generateKeyPair(1024);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = new Date(Date.now() - 86_400_000);
  caCert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86_400_000);
  const caAttrs = [{ shortName: "CN", value: "Computadores Test" }, { shortName: "O", value: "ARCA falso" }, { shortName: "C", value: "AR" }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const tickets = new Map<string, { cuit: string; expires: number }>(); // token → datos
  const activeByCert = new Map<string, number>(); // serial de certificado → vencimiento del TA
  const comps = new Map<string, Comp>(); // "cuit:pv:tipo:nro"
  const last = new Map<string, number>(); // "cuit:pv:tipo"
  const requests: { op: string; body: any }[] = [];
  let dropNext = false;
  let certSerial = 100;

  function signCsr(csrPem: string, opts: { validDays?: number } = {}): string {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    const cert = forge.pki.createCertificate();
    cert.publicKey = csr.publicKey!;
    cert.serialNumber = String(certSerial++);
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + (opts.validDays ?? 730) * 86_400_000);
    cert.setSubject(csr.subject.attributes);
    cert.setIssuer(caAttrs);
    cert.sign(caKeys.privateKey, forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
  }

  const app = Fastify();
  app.addContentTypeParser(["text/xml", "application/soap+xml"], { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/ws/services/LoginCms", async (req, reply) => {
    reply.type("text/xml");
    const body = parseXml(String(req.body)).Envelope?.Body;
    const cms = body?.loginCms?.in0;
    if (!cms) return reply.status(500).send(fault("ns1:cms.bad", "Falta el CMS"));
    let opened;
    try {
      opened = openCms(String(cms));
    } catch {
      return reply.status(500).send(fault("ns1:cms.bad", "CMS invalido"));
    }
    const cert = forge.pki.certificateFromPem(opened.certPem);
    if (!caCert.verify(cert)) return reply.status(500).send(fault("ns1:cms.cert.untrusted", "Certificado no emitido por AC de confianza"));
    if (cert.validity.notAfter < new Date()) return reply.status(500).send(fault("ns1:cms.cert.expired", "Certificado expirado"));
    const tra = parseXml(opened.content).loginTicketRequest;
    if (tra?.service !== "wsfe") return reply.status(500).send(fault("ns1:coe.notAuthorized", "Computador no autorizado a acceder al servicio"));
    const serial = cert.serialNumber;
    if ((activeByCert.get(serial) ?? 0) > Date.now()) {
      return reply.status(500).send(fault("ns1:coe.alreadyAuthenticated", "El CEE ya posee un TA valido para el acceso al WSN solicitado"));
    }
    const cuit = String((cert.subject.getField({ name: "serialNumber" }) as { value: string }).value).replace(/\D/g, "");
    const expires = Date.now() + 12 * 3_600_000;
    const token = `TOKEN-${serial}-${expires}`;
    tickets.set(token, { cuit, expires });
    activeByCert.set(serial, expires);
    const ticket =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><loginTicketResponse version="1.0"><header><source>CN=wsaahomo</source>` +
      `<destination>SERIALNUMBER=CUIT ${cuit}</destination><uniqueId>1</uniqueId><generationTime>${new Date().toISOString()}</generationTime>` +
      `<expirationTime>${new Date(expires).toISOString()}</expirationTime></header><credentials><token>${token}</token><sign>SIGN-${serial}</sign></credentials></loginTicketResponse>`;
    return soap(`<loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>${xmlEscape(ticket)}</loginCmsReturn></loginCmsResponse>`);
  });

  app.post("/wsfev1/service.asmx", async (req, reply) => {
    reply.type("text/xml");
    const action = String(req.headers.soapaction ?? "").replace(/"/g, "");
    const op = action.split("/").pop()!;
    const raw = String(req.body);
    const body = parseXml(raw).Envelope?.Body?.[op];
    requests.push({ op, body });
    const wrap = (inner: string) => soap(`<${op}Response xmlns="http://ar.gov.afip.dif.FEV1/"><${op}Result>${inner}</${op}Result></${op}Response>`);
    const err = (code: number, msg: string) => `<Errors><Err><Code>${code}</Code><Msg>${xmlEscape(msg)}</Msg></Err></Errors>`;

    if (op === "FEDummy") return wrap("<AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer>");

    const auth = body?.Auth;
    const t = tickets.get(String(auth?.Token));
    if (!t || t.expires < Date.now() || String(auth?.Sign ?? "").length === 0) return wrap(err(600, "ValidacionDeToken: No validaron las firmas digitales"));
    if (String(auth.Cuit) !== t.cuit) return wrap(err(600, "ValidacionDeToken: No aparecio CUIT en lista de relaciones"));
    const cuit = t.cuit;

    if (op === "FECompUltimoAutorizado") {
      const n = last.get(`${cuit}:${body.PtoVta}:${body.CbteTipo}`) ?? 0;
      return wrap(`<PtoVta>${body.PtoVta}</PtoVta><CbteTipo>${body.CbteTipo}</CbteTipo><CbteNro>${n}</CbteNro>`);
    }

    if (op === "FECompConsultar") {
      const q = body.FeCompConsReq;
      const c = comps.get(`${cuit}:${q.PtoVta}:${q.CbteTipo}:${q.CbteNro}`);
      if (!c) return wrap(err(602, "No existen datos en nuestros registros para los parametros ingresados."));
      return wrap(`<ResultGet><DocNro>${c.docNro}</DocNro><ImpTotal>${c.total}</ImpTotal><Resultado>A</Resultado><CodAutorizacion>${c.cae}</CodAutorizacion><FchVto>${c.caeVto}</FchVto><PtoVta>${c.ptoVta}</PtoVta><CbteTipo>${c.tipo}</CbteTipo></ResultGet>`);
    }

    if (op === "FECAESolicitar") {
      const cab = body.FeCAEReq.FeCabReq;
      const det = body.FeCAEReq.FeDetReq.FECAEDetRequest;
      const tipo = Number(cab.CbteTipo);
      const pv = Number(cab.PtoVta);
      const key = `${cuit}:${pv}:${tipo}`;
      const reject = (code: number, msg: string) =>
        wrap(`<FeCabResp><Cuit>${cuit}</Cuit><PtoVta>${pv}</PtoVta><CbteTipo>${tipo}</CbteTipo><CantReg>1</CantReg><Resultado>R</Resultado></FeCabResp>` +
          `<FeDetResp><FECAEDetResponse><Concepto>1</Concepto><DocTipo>${det.DocTipo}</DocTipo><DocNro>${det.DocNro}</DocNro><CbteDesde>${det.CbteDesde}</CbteDesde><CbteHasta>${det.CbteHasta}</CbteHasta><Resultado>R</Resultado></FECAEDetResponse></FeDetResp>${err(code, msg)}`);

      // El orden de los elementos importa en el servicio real (.asmx).
      const detXml = raw.slice(raw.indexOf("FECAEDetRequest>"), raw.lastIndexOf("FECAEDetRequest>"));
      // Primera aparición de cada campo de primer nivel (CbtesAsoc tiene su propio CbteFch adentro).
      const sent = [...new Set([...detXml.matchAll(/<(?:\w+:)?(\w+)>/g)].map((m) => m[1]!).filter((n) => DET_ORDER.includes(n)))];
      const expected = DET_ORDER.filter((n) => sent.includes(n));
      if (sent.join() !== expected.join()) return reject(10000, `Orden de campos inválido: ${sent.join(",")}`);

      const next = (last.get(key) ?? 0) + 1;
      if (Number(det.CbteDesde) !== next || Number(det.CbteHasta) !== next) {
        return reject(10016, "El numero o fecha del comprobante no se corresponde con el proximo a autorizar.");
      }
      if (det.CondicionIVAReceptorId === undefined) return reject(10246, "Campo Condicion Frente al IVA del receptor es obligatorio.");
      const n = (v: unknown) => Number(v ?? 0);
      const sum = n(det.ImpNeto) + n(det.ImpIVA) + n(det.ImpTrib) + n(det.ImpOpEx) + n(det.ImpTotConc);
      if (Math.abs(sum - n(det.ImpTotal)) > 0.001) return reject(10048, "El campo 'Importe Total' ImpTotal, debe ser igual a la suma de ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA.");
      const alics = list(det.Iva?.AlicIva);
      if ([11, 13].includes(tipo) && alics.length) return reject(10071, "Para comprobantes tipo C el objeto IVA no debe informarse.");
      if (![11, 13].includes(tipo)) {
        const ivaSum = alics.reduce((s, a) => s + n(a.Importe), 0);
        if (Math.abs(ivaSum - n(det.ImpIVA)) > 0.001) return reject(10051, "La suma de los importes de IVA no coincide con ImpIVA.");
      }
      const cond = Number(det.CondicionIVAReceptorId);
      if (tipo === 6 && [1, 6].includes(cond)) return reject(10243, "La condicion IVA del receptor no es valida para comprobantes clase B.");
      if (tipo === 1 && ![1, 6, 13, 16].includes(cond)) return reject(10243, "La condicion IVA del receptor no es valida para comprobantes clase A.");
      if ([3, 8, 13].includes(tipo)) {
        const asoc = list(det.CbtesAsoc?.CbteAsoc)[0];
        if (!asoc || !comps.has(`${cuit}:${asoc.PtoVta}:${asoc.Tipo}:${asoc.Nro}`)) return reject(10040, "Debe informar comprobantes asociados existentes.");
      }

      last.set(key, next);
      const cae = String(70000000000000 + comps.size + 1);
      const vto = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
      comps.set(`${key}:${next}`, { tipo, ptoVta: pv, numero: next, total: String(det.ImpTotal), docNro: String(det.DocNro), cae, caeVto: vto, fecha: String(det.CbteFch) });
      if (dropNext) {
        // Simula que ARCA autorizó pero la respuesta nunca llegó.
        dropNext = false;
        reply.raw.destroy();
        return reply;
      }
      return wrap(
        `<FeCabResp><Cuit>${cuit}</Cuit><PtoVta>${pv}</PtoVta><CbteTipo>${tipo}</CbteTipo><FchProceso>20261028</FchProceso><CantReg>1</CantReg><Resultado>A</Resultado><Reproceso>N</Reproceso></FeCabResp>` +
          `<FeDetResp><FECAEDetResponse><Concepto>1</Concepto><DocTipo>${det.DocTipo}</DocTipo><DocNro>${det.DocNro}</DocNro><CbteDesde>${next}</CbteDesde><CbteHasta>${next}</CbteHasta><CbteFch>${det.CbteFch}</CbteFch><Resultado>A</Resultado><CAE>${cae}</CAE><CAEFchVto>${vto}</CAEFchVto></FECAEDetResponse></FeDetResp>`,
      );
    }
    return reply.status(500).send(fault("soap:Client", `Operación desconocida: ${op}`));
  });

  // Control de los tests.
  app.get("/__fake/health", async () => ({ ok: true }));
  app.post("/__fake/sign-csr", async (req) => ({ certPem: signCsr(String((req.body as { csrPem: string }).csrPem)) }));
  app.post("/__fake/drop-next", async () => {
    dropNext = true;
    return { ok: true };
  });
  app.post<{ Body: { cuit: string; ptoVta: number; tipo: number; numero: number } }>("/__fake/bump", async (req) => {
    // Simula un comprobante emitido por fuera de Mis Ventas (por ejemplo, desde el portal de ARCA).
    const { cuit, ptoVta, tipo, numero } = req.body;
    last.set(`${cuit}:${ptoVta}:${tipo}`, numero);
    return { ok: true };
  });

  const url = await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
  return {
    url,
    signCsr,
    requests,
    comps,
    dropNextResponse: () => {
      dropNext = true;
    },
    close: () => app.close(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeArca({ port: Number(process.env.PORT ?? 3102) });
  console.log(`ARCA falso en ${fake.url}`);
}
