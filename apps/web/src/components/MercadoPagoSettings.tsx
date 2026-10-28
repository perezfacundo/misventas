import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CreditCard, ExternalLink, MapPin, QrCode } from "lucide-react";
import { getCloudLink } from "../sync/engine";
import { db } from "../db";
import {
  createQrPos, disconnectMp, getMpConfig, listMpPos, listMpTerminals, saveMpConfig, setTerminalPdv, type MpConfig,
} from "../payments/mercadopago";
import { Button, Card, Field, inputClass, Modal, TextInput, useToast } from "./ui";

type PosList = Awaited<ReturnType<typeof listMpPos>>;
type TerminalList = Awaited<ReturnType<typeof listMpTerminals>>;

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Algo salió mal.");

/** Conectar Mercado Pago para cobrar con QR y Point desde la caja (solo el dueño). */
export function MercadoPagoSettings() {
  const cloud = useLiveQuery(getCloudLink, []);
  const [config, setConfig] = useState<MpConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<PosList | null>(null);
  const [terminals, setTerminals] = useState<TerminalList | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [creatingQr, setCreatingQr] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const c = await getMpConfig();
      setConfig(c);
      setError(null);
      if (c.connected) {
        const [p, t] = await Promise.allSettled([listMpPos(), listMpTerminals()]);
        setPos(p.status === "fulfilled" ? p.value : []);
        setTerminals(t.status === "fulfilled" ? t.value : []);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (cloud) void load();
  }, [cloud, load]);

  const save = async (patch: Parameters<typeof saveMpConfig>[0], ok: string) => {
    try {
      await saveMpConfig(patch);
      toast({ tone: "ok", message: ok });
      await load();
    } catch (e) {
      toast({ tone: "error", message: errorText(e) });
    }
  };

  const header = (
    <h2 className="mb-1 flex items-center gap-2 text-xl font-bold"><QrCode className="size-6 text-brand" /> Mercado Pago</h2>
  );

  if (!cloud) {
    return (
      <Card>
        {header}
        <p className="text-muted">Para cobrar con QR o Point desde la caja, primero conectá este dispositivo a la nube (arriba).</p>
      </Card>
    );
  }
  if (error) {
    return <Card>{header}<p className="text-muted">No se pudo consultar Mercado Pago: {error}</p></Card>;
  }
  if (!config) return <Card>{header}<p className="text-muted">Cargando…</p></Card>;
  if (!config.available) {
    return <Card>{header}<p className="text-muted">El servidor no tiene configurada la clave <code>APP_SECRET</code>, que hace falta para guardar el token de Mercado Pago de forma segura.</p></Card>;
  }

  if (!config.connected) {
    return (
      <Card>
        {header}
        <p className="mb-4 text-muted">Cobrá con el QR de la caja o mandá el cobro al posnet Point, y la venta se registra sola cuando entra el pago.</p>
        <Button variant="primary" onClick={() => setConnecting(true)}>Conectar Mercado Pago</Button>
        <ConnectDialog open={connecting} onClose={() => setConnecting(false)} onConnected={load} />
      </Card>
    );
  }

  const qrPos = (pos ?? []).filter((p) => p.externalId);
  const selectedTerminal = terminals?.find((t) => t.id === config.terminalId);

  return (
    <Card>
      {header}
      <p className="mb-5 text-muted">Conectado a la cuenta <b className="text-ink">{config.nickname ?? "de Mercado Pago"}</b>.</p>
      <div className="flex flex-col gap-5">
        <Field label="Caja con QR" hint="El cliente paga escaneando el QR que aparece en pantalla (o el impreso de esa caja).">
          <select
            className={inputClass}
            value={config.externalPosId ?? ""}
            onChange={(e) => void save({ externalPosId: e.target.value || null }, e.target.value ? "Caja QR elegida" : "Cobro con QR desactivado")}
          >
            <option value="">No cobrar con QR</option>
            {qrPos.map((p) => <option key={p.id} value={p.externalId!}>{p.name} ({p.externalId})</option>)}
          </select>
        </Field>
        {pos && !qrPos.length && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
            <span className="text-muted">Tu cuenta todavía no tiene una caja QR lista para integrar. La creamos en un paso.</span>
            <Button onClick={() => setCreatingQr(true)}><QrCode className="size-5" /> Crear caja QR</Button>
          </div>
        )}

        <Field label="Posnet Point" hint="El cobro se manda al posnet y el cliente pasa la tarjeta ahí.">
          <select
            className={inputClass}
            value={config.terminalId ?? ""}
            onChange={(e) => void save({ terminalId: e.target.value || null }, e.target.value ? "Posnet elegido" : "Cobro con Point desactivado")}
          >
            <option value="">No cobrar con Point</option>
            {(terminals ?? []).map((t) => <option key={t.id} value={t.id}>{t.id.split("__").at(-1)} · {t.operatingMode === "PDV" ? "integrado" : "no integrado"}</option>)}
          </select>
        </Field>
        {selectedTerminal && selectedTerminal.operatingMode !== "PDV" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warn-soft px-4 py-3">
            <span className="font-semibold text-warn">Este posnet no está en modo integrado (PDV): todavía no puede recibir cobros desde la caja.</span>
            <Button onClick={async () => {
              try {
                await setTerminalPdv(selectedTerminal.id);
                toast({ tone: "ok", message: "Listo. Reiniciá el posnet para que tome el cambio." });
                await load();
              } catch (e) {
                toast({ tone: "error", message: errorText(e) });
              }
            }}>
              <CreditCard className="size-5" /> Activar modo integrado
            </Button>
          </div>
        )}

        <WebhookSection config={config} onSave={save} />

        <Button variant="ghost" className="self-start" onClick={() => setConfirmOff(true)}>Desconectar Mercado Pago</Button>
      </div>
      <CreateQrDialog open={creatingQr} onClose={() => setCreatingQr(false)} onCreated={load} />
      <Modal open={confirmOff} onClose={() => setConfirmOff(false)} title="Desconectar Mercado Pago" footer={
        <>
          <Button onClick={() => setConfirmOff(false)}>Cancelar</Button>
          <Button variant="danger" onClick={async () => { await disconnectMp(); setConfirmOff(false); await load(); }}>Desconectar</Button>
        </>
      }>
        <p className="text-lg">Las cajas dejan de cobrar con QR y Point integrados. Mercado Pago se puede seguir registrando a mano.</p>
      </Modal>
    </Card>
  );
}

function WebhookSection({ config, onSave }: { config: MpConfig; onSave: (p: { webhookSecret: string | null }, ok: string) => Promise<void> }) {
  const [secret, setSecret] = useState("");
  return (
    <details className="rounded-xl border border-line px-4 py-3">
      <summary className="cursor-pointer font-semibold">Avisos instantáneos (webhook) — opcional</summary>
      <div className="mt-3 flex flex-col gap-3 text-muted">
        <p>
          Sin esto los pagos igual se detectan (la caja consulta cada pocos segundos). Con el webhook, la confirmación llega al instante.
          En tu aplicación de Mercado Pago, en <b className="text-ink">Webhooks → Configurar notificaciones</b>, activá el evento <b className="text-ink">Order</b> y pegá esta dirección:
        </p>
        <code className="break-all rounded-lg bg-surface-2 px-3 py-2 text-ink">{config.webhookUrl ?? "https://TU-DOMINIO/api/webhooks/mercadopago"}</code>
        <Field label={config.hasWebhookSecret ? "Clave secreta (ya cargada; pegá otra para cambiarla)" : "Clave secreta del webhook"}>
          <TextInput value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="La que muestra Mercado Pago al configurar el webhook" />
        </Field>
        <Button className="self-start" disabled={!secret.trim()} onClick={() => void onSave({ webhookSecret: secret.trim() }, "Clave del webhook guardada").then(() => setSecret(""))}>
          Guardar clave
        </Button>
      </div>
    </details>
  );
}

function ConnectDialog({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setToken(""); setError(null); }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveMpConfig({ accessToken: token.trim() });
      onClose();
      await onConnected();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Conectar Mercado Pago" footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={submit} disabled={busy || token.trim().length < 10}>{busy ? "Verificando…" : "Conectar"}</Button>
      </>
    }>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <ol className="list-decimal space-y-1.5 pl-5 text-muted">
          <li>Entrá a <a className="inline-flex items-center gap-1 font-semibold text-ink underline" href="https://www.mercadopago.com.ar/developers/panel/app" target="_blank" rel="noreferrer">Mercado Pago Developers <ExternalLink className="size-4" /></a> con la cuenta del kiosco.</li>
          <li>Creá una aplicación (tipo “Pagos presenciales”).</li>
          <li>En <b className="text-ink">Credenciales de producción</b>, copiá el <b className="text-ink">Access Token</b> y pegalo acá.</li>
        </ol>
        <Field label="Access Token" hint="Se guarda cifrado en el servidor y nunca se muestra en las cajas.">
          <TextInput value={token} onChange={(e) => setToken(e.target.value)} placeholder="APP_USR-…" autoComplete="off" spellCheck={false} />
        </Field>
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

const PROVINCES = [
  "Capital Federal", "Buenos Aires", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes", "Entre Ríos", "Formosa", "Jujuy",
  "La Pampa", "La Rioja", "Mendoza", "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis", "Santa Cruz",
  "Santa Fe", "Santiago del Estero", "Tierra del Fuego", "Tucumán",
];

/** Crea el local y la caja QR en Mercado Pago con la dirección del kiosco. */
function CreateQrDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [d, setD] = useState({ storeName: "", streetName: "", streetNumber: "", city: "", state: "Buenos Aires" });
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const business = useLiveQuery(() => db.business.get("business"), []);

  useEffect(() => {
    if (open) {
      setError(null);
      setD((x) => ({ ...x, storeName: x.storeName || business?.businessName || "" }));
    }
  }, [open, business?.businessName]);

  const locate = () => {
    if (!navigator.geolocation) return setError("Este dispositivo no puede dar la ubicación.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setCoords({ latitude: p.coords.latitude, longitude: p.coords.longitude }); setLocating(false); },
      () => { setError("No se pudo obtener la ubicación. Revisá el permiso del navegador."); setLocating(false); },
      { enableHighAccuracy: false, timeout: 15_000 },
    );
  };

  const ready = d.storeName.trim() && d.streetName.trim() && d.streetNumber.trim() && d.city.trim() && coords;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await createQrPos({ ...d, ...coords! });
      toast({ tone: "ok", message: "Caja QR creada. Ya podés cobrar con QR." });
      onClose();
      await onCreated();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Crear caja QR" footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={submit} disabled={!ready || busy}>{busy ? "Creando…" : "Crear caja"}</Button>
      </>
    }>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="text-muted sm:col-span-2">Mercado Pago pide la dirección del local. Se crea un local con una caja, lista para cobrar desde Mis Ventas.</p>
        <div className="sm:col-span-2"><Field label="Nombre del local"><TextInput value={d.storeName} onChange={set("storeName")} /></Field></div>
        <Field label="Calle"><TextInput value={d.streetName} onChange={set("streetName")} /></Field>
        <Field label="Número"><TextInput inputMode="numeric" value={d.streetNumber} onChange={set("streetNumber")} /></Field>
        <Field label="Localidad"><TextInput value={d.city} onChange={set("city")} /></Field>
        <Field label="Provincia">
          <select className={inputClass} value={d.state} onChange={set("state")}>
            {PROVINCES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button onClick={locate} disabled={locating}><MapPin className="size-5" /> {coords ? "Ubicación tomada ✓" : locating ? "Buscando…" : "Usar la ubicación de este dispositivo"}</Button>
          <span className="text-sm text-muted">Hacelo estando en el kiosco.</span>
        </div>
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger sm:col-span-2">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
