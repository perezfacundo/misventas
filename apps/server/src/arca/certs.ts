import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";

/**
 * Certificado para los web services de ARCA. La clave privada se genera en el servidor y no sale de ahí:
 * el dueño solo descarga el pedido (CSR), lo sube a ARCA y vuelve con el certificado firmado.
 */
export function generateKeyAndCsr(input: { cuit: string; razonSocial: string }): { keyPem: string; csrPem: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const key = forge.pki.privateKeyFromPem(keyPem);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  // ARCA identifica al contribuyente por el serialNumber "CUIT nnnnnnnnnnn".
  csr.setSubject([
    { shortName: "C", value: "AR" },
    { shortName: "O", value: input.razonSocial.slice(0, 60) },
    { shortName: "CN", value: "misventas" },
    { name: "serialNumber", value: `CUIT ${input.cuit.replace(/\D/g, "")}` },
  ]);
  csr.sign(key, forge.md.sha256.create());
  return { keyPem, csrPem: forge.pki.certificationRequestToPem(csr) };
}

export interface CertificateInfo {
  cuit: string | null;
  notBefore: Date;
  notAfter: Date;
  issuer: string;
}

export function readCertificate(pem: string): CertificateInfo {
  const cert = forge.pki.certificateFromPem(pem.trim());
  const serial = cert.subject.getField({ name: "serialNumber" }) as { value?: string } | null;
  const issuerCn = cert.issuer.getField("CN") as { value?: string } | null;
  return {
    cuit: serial?.value?.replace(/\D/g, "") || null,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    issuer: issuerCn?.value ?? "",
  };
}

/** ¿El certificado corresponde a esta clave? (mismo módulo RSA) */
export function certificateMatchesKey(certPem: string, keyPem: string): boolean {
  const cert = forge.pki.certificateFromPem(certPem.trim());
  const key = forge.pki.privateKeyFromPem(keyPem);
  const pub = cert.publicKey as forge.pki.rsa.PublicKey;
  return pub.n.equals(key.n) && pub.e.equals(key.e);
}

/** Firma el pedido de acceso (TRA) como CMS/PKCS#7 con el contenido adentro, en Base64, como pide WSAA. */
export function signCms(content: string, certPem: string, keyPem: string): string {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content, "utf8");
  const cert = forge.pki.certificateFromPem(certPem.trim());
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime!, value: new Date() as unknown as string },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

/** Para el ARCA falso de los tests: extrae el contenido firmado y el certificado de un CMS. */
export function openCms(base64: string): { content: string; certPem: string } {
  const asn1 = forge.asn1.fromDer(forge.util.decode64(base64));
  const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;
  const cert = p7.certificates[0];
  // forge no conserva el contenido al leer: se recorre el ASN.1 (RFC 5652).
  // ContentInfo → [0] SignedData → encapContentInfo → [0] → OCTET STRING (a veces en partes).
  const children = (n: forge.asn1.Asn1 | undefined) => (n && Array.isArray(n.value) ? (n.value as forge.asn1.Asn1[]) : []);
  const signedData = children(children(asn1)[1])[0];
  const encap = children(signedData)[2];
  const octet = children(children(encap)[1])[0];
  const bytes = typeof octet?.value === "string" ? octet.value : children(octet).map((part) => String(part.value)).join("");
  if (!cert || !bytes) throw new Error("CMS sin certificado o sin contenido");
  return { content: forge.util.decodeUtf8(bytes), certPem: forge.pki.certificateToPem(cert) };
}
