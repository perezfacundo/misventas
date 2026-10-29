import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CheckCircle2, Download, FileBadge, Receipt, Upload } from "lucide-react";
import { CBTE_LABELS, formatCuit, isValidCuit, ISSUER_CONDITION_LABELS, type IssuerCondition } from "@misventas/core";
import type { InvoiceMode, Settings } from "../db";
import { saveSettings } from "../data/settings";
import { getCloudLink } from "../sync/engine";
import { generateCsr, getArcaConfig, saveArcaConfig, testArca, uploadCertificate, type ArcaConfig, type ArcaConfigInput } from "../fiscal/arca";
import { downloadFile } from "../data/csv";
import { formatDate } from "../lib/format";
import { Button, Card, cx, Field, Segmented, TextInput, useToast } from "./ui";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Algo salió mal.");

/** Factura electrónica con ARCA: datos fiscales, certificado, prueba y cuándo facturar (solo el dueño). */
export function ArcaSettings({ settings }: { settings: Settings }) {
  const cloud = useLiveQuery(getCloudLink, []);
  const [config, setConfig] = useState<ArcaConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const load = useCallback(async () => {
    try {
      setConfig(await getArcaConfig());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    if (cloud) void load();
  }, [cloud, load]);

  const header = <h2 className="mb-1 flex items-center gap-2 text-xl font-bold"><Receipt className="size-6 text-brand" /> Factura electrónica (ARCA)</h2>;
  if (!cloud) return <Card>{header}<p className="text-muted">Para facturar con ARCA, primero conectá este dispositivo a la nube (arriba). El certificado fiscal se guarda en el servidor, nunca en las cajas.</p></Card>;
  if (error) return <Card>{header}<p className="text-muted">No se pudo consultar la configuración: {error}</p></Card>;
  if (!config) return <Card>{header}<p className="text-muted">Cargando…</p></Card>;
  if (!config.available) return <Card>{header}<p className="text-muted">El servidor no tiene configurada la clave <code>APP_SECRET</code>, que hace falta para guardar el certificado de forma segura.</p></Card>;

  return (
    <Card>
      {header}
      <p className="mb-5 text-muted">
        Emití factura {config.condicion === "monotributo" ? "C" : "A o B"} desde la caja. Sin internet la venta se hace igual y la factura sale sola cuando vuelve la conexión.
      </p>
      <div className="flex flex-col gap-6">
        <Step n={1} title="Datos fiscales" done={config.configured}>
          <FiscalForm config={config} onSaved={async (input) => {
            // El CUIT fiscal es también el que va en el ticket interno: un solo lugar para cargarlo.
            await saveSettings({ fiscalCondition: input.condicion, taxId: formatCuit(input.cuit) });
            await load();
          }} />
        </Step>
        <Step n={2} title="Certificado" done={config.hasCert} disabled={!config.configured}>
          <CertificateStep config={config} onChange={load} />
        </Step>
        <Step n={3} title="Autorizar y probar" done={tested} disabled={!config.hasCert}>
          <TestStep config={config} onTested={() => setTested(true)} />
        </Step>
        <Step n={4} title="¿Cuándo facturar?" done={config.ready && (settings.invoiceMode ?? "nunca") !== "nunca"} disabled={!config.ready}>
          <Segmented<InvoiceMode>
            label="Cuándo facturar"
            value={settings.invoiceMode ?? "nunca"}
            onChange={(invoiceMode) => void saveSettings({ invoiceMode })}
            options={[
              { value: "nunca", label: "Nunca" },
              { value: "preguntar", label: "Preguntar en cada venta" },
              { value: "siempre", label: "Siempre" },
            ]}
          />
          <p className="mt-2 text-sm text-muted">Con “Preguntar”, al cobrar aparece la opción de hacer factura. Con “Siempre”, viene marcada.</p>
        </Step>
      </div>
    </Card>
  );
}

function Step({ n, title, done, disabled = false, children }: { n: number; title: string; done: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <section className={cx("rounded-2xl border border-line p-4", disabled && "opacity-50")} aria-disabled={disabled}>
      <h3 className="mb-3 flex items-center gap-2 text-lg font-bold">
        {done ? <CheckCircle2 className="size-6 text-brand" /> : <span className="grid size-6 place-items-center rounded-full bg-surface-2 text-sm">{n}</span>}
        {title}
      </h3>
      {disabled ? <p className="text-muted">Completá el paso anterior.</p> : children}
    </section>
  );
}

function FiscalForm({ config, onSaved }: { config: ArcaConfig; onSaved: (input: ArcaConfigInput) => Promise<void> }) {
  const [d, setD] = useState<ArcaConfigInput>({
    cuit: config.cuit ? formatCuit(config.cuit) : "",
    razonSocial: config.razonSocial,
    condicion: config.condicion,
    ptoVta: config.ptoVta,
    ambiente: config.ambiente,
    domicilio: config.domicilio,
    iibb: config.iibb,
    inicioActividades: config.inicioActividades,
  });
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const set = <K extends keyof ArcaConfigInput>(k: K, v: ArcaConfigInput[K]) => setD({ ...d, [k]: v });
  const save = async () => {
    if (!isValidCuit(d.cuit)) return setError("El CUIT no es válido: revisá los números.");
    try {
      await saveArcaConfig({ ...d, cuit: d.cuit.replace(/\D/g, "") });
      toast({ tone: "ok", message: "Datos fiscales guardados" });
      setError(null);
      await onSaved(d);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="CUIT"><TextInput inputMode="numeric" value={d.cuit} onChange={(e) => set("cuit", e.target.value)} placeholder="20-12345678-9" /></Field>
      <Field label="Razón social o nombre"><TextInput value={d.razonSocial} onChange={(e) => set("razonSocial", e.target.value)} /></Field>
      <div className="sm:col-span-2">
        <Field label="Condición frente al IVA" group>
          <Segmented<IssuerCondition> label="Condición frente al IVA" value={d.condicion} onChange={(v) => set("condicion", v)}
            options={[{ value: "monotributo", label: ISSUER_CONDITION_LABELS.monotributo }, { value: "responsable_inscripto", label: ISSUER_CONDITION_LABELS.responsable_inscripto }]} />
        </Field>
      </div>
      <Field label="Punto de venta" hint="El número de punto de venta para web services que creaste en ARCA.">
        <TextInput inputMode="numeric" value={String(d.ptoVta)} onChange={(e) => set("ptoVta", Number(e.target.value.replace(/\D/g, "")) || 1)} />
      </Field>
      <Field label="Inicio de actividades"><TextInput type="date" value={d.inicioActividades} onChange={(e) => set("inicioActividades", e.target.value)} /></Field>
      <Field label="Domicilio comercial"><TextInput value={d.domicilio} onChange={(e) => set("domicilio", e.target.value)} /></Field>
      <Field label="Ingresos Brutos (n.º o “Exento”)"><TextInput value={d.iibb} onChange={(e) => set("iibb", e.target.value)} /></Field>
      <div className="sm:col-span-2">
        <Field label="Ambiente" group hint={config.demo ? "En la versión de prueba solo se puede usar homologación." : "Probá primero en homologación: las facturas de prueba no tienen validez fiscal."}>
          <Segmented label="Ambiente" value={d.ambiente} onChange={(v) => set("ambiente", config.demo ? "homologacion" : v)}
            options={[{ value: "homologacion", label: "Pruebas (homologación)" }, { value: "produccion", label: "Real (producción)" }]} />
        </Field>
      </div>
      {error && <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger sm:col-span-2">{error}</p>}
      <Button type="submit" variant="primary" className="self-start sm:col-span-2">Guardar datos fiscales</Button>
    </form>
  );
}

function CertificateStep({ config, onChange }: { config: ArcaConfig; onChange: () => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const homo = config.ambiente === "homologacion";
  const csrName = `pedido-certificado-${config.cuit}.csr`;

  const newCsr = async () => {
    setBusy(true);
    try {
      await generateCsr();
      await onChange();
    } catch (e) {
      toast({ tone: "error", message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (config.hasCert) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2"><FileBadge className="size-5 text-brand" /> Certificado cargado{config.certExpiresAt ? `, vence el ${formatDate(new Date(config.certExpiresAt))}` : ""}.</p>
        <Button variant="ghost" onClick={newCsr} disabled={busy}>Renovar certificado</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {!config.csrPem ? (
        <>
          <p className="text-muted">Mis Ventas genera la clave privada en el servidor (nunca sale de ahí) y un pedido de certificado para que lo firme ARCA.</p>
          <Button variant="primary" className="self-start" onClick={newCsr} disabled={busy}>{busy ? "Generando…" : "Generar pedido de certificado"}</Button>
        </>
      ) : (
        <>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Descargá el pedido:{" "}
              <Button className="ml-1" onClick={() => downloadFile(csrName, config.csrPem!, "application/pkcs10")}><Download className="size-5" /> Descargar pedido (.csr)</Button>
            </li>
            {homo ? (
              <li>Entrá a ARCA con tu clave fiscal, al servicio <b>“WSASS – Autogestión Certificados Homologación”</b>. Creá un certificado nuevo pegando el contenido del pedido y descargalo.</li>
            ) : (
              <li>Entrá a ARCA con tu clave fiscal, al servicio <b>“Administración de Certificados Digitales”</b>. Agregá un alias (por ejemplo “misventas”), subí el pedido y descargá el certificado.</li>
            )}
            <li>
              Subí acá el certificado (.crt o .pem):{" "}
              <Button className="ml-1" onClick={() => fileRef.current?.click()}><Upload className="size-5" /> Subir certificado</Button>
            </li>
          </ol>
          <input
            ref={fileRef}
            type="file"
            accept=".crt,.pem,.cer,application/x-x509-ca-cert"
            hidden
            aria-label="Certificado de ARCA"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                await uploadCertificate(await file.text());
                toast({ tone: "ok", message: "Certificado cargado" });
                await onChange();
              } catch (err) {
                toast({ tone: "error", message: errorText(err) });
              }
            }}
          />
          <button type="button" onClick={newCsr} className="self-start text-sm font-semibold text-muted underline underline-offset-4">Generar otro pedido</button>
        </>
      )}
    </div>
  );
}

function TestStep({ config, onTested }: { config: ArcaConfig; onTested: () => void }) {
  const [result, setResult] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const homo = config.ambiente === "homologacion";
  return (
    <div className="flex flex-col gap-3">
      <ol className="list-decimal space-y-1.5 pl-5 text-muted">
        <li>En ARCA, en <b className="text-ink">“Administrador de Relaciones de Clave Fiscal”</b>, creá una nueva relación con el servicio <b className="text-ink">“Facturación Electrónica”</b>{homo ? " (en homologación se hace desde WSASS → “Crear autorización a servicio”, servicio wsfe)" : ""} y elegí como representante el certificado que cargaste.</li>
        {!homo && <li>En <b className="text-ink">“Administración de puntos de venta y domicilios”</b>, creá el punto de venta {config.ptoVta} para <b className="text-ink">“Factura Electrónica – Web Services”</b>.</li>}
      </ol>
      <Button className="self-start" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await testArca();
          setOk(r.ok);
          setResult(`Conexión ${r.ok ? "correcta" : "con problemas"}. ${Object.entries(r.last).map(([t, n]) => `${CBTE_LABELS[Number(t)]}: último n.º ${n}`).join(" · ")}`);
          if (r.ok) onTested();
        } catch (e) {
          setOk(false);
          setResult(errorText(e));
        } finally {
          setBusy(false);
        }
      }}>
        {busy ? "Probando…" : "Probar conexión con ARCA"}
      </Button>
      {result && <p role="status" className={cx("rounded-xl px-4 py-3 font-semibold", ok ? "bg-brand-soft" : "bg-danger-soft text-danger")}>{result}</p>}
    </div>
  );
}
