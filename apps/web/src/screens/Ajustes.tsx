import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Cloud, Download, KeyRound, Laptop, Plus, RefreshCw, Upload, UserRound } from "lucide-react";
import { PAYMENT_LABELS, pesos, ROLE_LABELS, type PaymentMethod, type Role } from "@misventas/core";
import { db, type Settings, type User } from "../db";
import { saveSettings } from "../data/settings";
import { exportBackup, importBackup } from "../data/backup";
import { recomputeAllStock } from "../data/products";
import { downloadFile } from "../data/csv";
import { createUser, updateUser, useUsers } from "../data/users";
import {
  ApiError, getCloudLink, listDevices, loginAccount, registerAccount, revokeDevice, serverConfigured, syncNow, unlink, useSyncStatus,
  type LinkedDevice,
} from "../sync/engine";
import { isValidPin } from "../lib/pin";
import { formatDate, formatDateTime, formatTime } from "../lib/format";
import { Button, Card, Field, Modal, PageHeader, Segmented, TextInput, Toggle, useToast } from "../components/ui";
import { useSession } from "../components/Session";
import { MercadoPagoSettings } from "../components/MercadoPagoSettings";
import { PrinterSettings } from "../components/PrinterSettings";

const ALL_METHODS: PaymentMethod[] = ["efectivo", "debito", "credito", "transferencia", "mercadopago", "fiado"];

export function Ajustes({ settings }: { settings: Settings }) {
  const toast = useToast();
  const { can } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingBackup, setPendingBackup] = useState<string | null>(null);
  const save = (patch: Partial<Settings>) => void saveSettings(patch);

  return (
    <div className="mx-auto max-w-3xl p-4 lg:p-8">
      <PageHeader title="Ajustes" />
      <div className="flex flex-col gap-6">
        <Card>
          <h2 className="mb-4 text-xl font-bold">Cómo se ve</h2>
          <div className="flex flex-col gap-5">
            <Field label="Tamaño del texto" group>
              <Segmented label="Tamaño del texto" value={settings.textSize} onChange={(textSize) => save({ textSize })}
                options={[{ value: "normal", label: "Normal" }, { value: "grande", label: "Grande" }, { value: "muy-grande", label: "Muy grande" }]} />
            </Field>
            <Field label="Colores" group>
              <Segmented label="Tema" value={settings.theme} onChange={(theme) => save({ theme })}
                options={[{ value: "auto", label: "Automático" }, { value: "claro", label: "Claro" }, { value: "oscuro", label: "Oscuro" }]} />
            </Field>
          </div>
        </Card>

        {can("ajustes") && <CloudCard />}
        {can("ajustes") && <MercadoPagoSettings />}
        {can("usuarios") && <UsersCard />}

        {can("ajustes") && (
          <>
            <Card>
              <h2 className="mb-4 text-xl font-bold">Tu kiosco</h2>
              <div className="grid gap-5 sm:grid-cols-2">
                <SettingText label="Nombre del kiosco" value={settings.businessName} onSave={(businessName) => save({ businessName })} />
                <SettingText label="Dirección" value={settings.address} onSave={(address) => save({ address })} />
                <SettingText label="CUIT (opcional)" value={settings.taxId} onSave={(taxId) => save({ taxId })} />
                <SettingText label="Mensaje al pie del ticket" value={settings.ticketFooter} onSave={(ticketFooter) => save({ ticketFooter })} />
              </div>
            </Card>

            <Card>
              <h2 className="mb-1 text-xl font-bold">Medios de pago</h2>
              <p className="mb-4 text-muted">Los que no usás no aparecen al cobrar.</p>
              <div className="flex flex-col gap-1">
                {ALL_METHODS.map((m) => (
                  <Toggle
                    key={m}
                    label={PAYMENT_LABELS[m]}
                    hint={
                      m === "mercadopago" ? "Con Mercado Pago conectado (más arriba) se cobra con QR o Point; si no, se registra a mano."
                        : m === "fiado" ? "Anota la compra en la cuenta del cliente." : undefined
                    }
                    checked={settings.enabledMethods.includes(m)}
                    onChange={(on) => {
                      const next = on ? ALL_METHODS.filter((x) => x === m || settings.enabledMethods.includes(x)) : settings.enabledMethods.filter((x) => x !== m);
                      if (next.length) save({ enabledMethods: next });
                    }}
                  />
                ))}
              </div>
            </Card>

            <Card>
              <h2 className="mb-4 text-xl font-bold">Tickets y precios</h2>
              <div className="flex flex-col gap-5">
                <Toggle checked={settings.autoPrint} onChange={(autoPrint) => save({ autoPrint })} label="Imprimir el ticket en cada venta" hint="Si está apagado, lo imprimís solo cuando el cliente lo pide." />
                <Field label="Ancho del papel" group>
                  <Segmented label="Ancho del papel" value={settings.paperWidth} onChange={(paperWidth) => save({ paperWidth })}
                    options={[{ value: 58, label: "58 mm" }, { value: 80, label: "80 mm" }]} />
                </Field>
                <PrinterSettings settings={settings} />
                <Field label="Redondeo al actualizar precios" group>
                  <Segmented label="Redondeo" value={settings.priceRounding} onChange={(priceRounding) => save({ priceRounding })}
                    options={[{ value: 0, label: "Sin redondeo" }, { value: pesos(10), label: "$10" }, { value: pesos(50), label: "$50" }, { value: pesos(100), label: "$100" }]} />
                </Field>
              </div>
            </Card>

            <Card>
              <h2 className="mb-1 text-xl font-bold">Copia de seguridad</h2>
              <p className="mb-4 text-muted">Descargá una copia cada tanto y guardala en otro lado. Si usás la nube, tus datos ya están respaldados.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={async () => downloadFile(`misventas-copia-${formatDate(Date.now()).replace(/\//g, "-")}.json`, await exportBackup(), "application/json")}>
                  <Download className="size-5" /> Descargar copia
                </Button>
                <Button onClick={() => fileRef.current?.click()}><Upload className="size-5" /> Restaurar una copia</Button>
                <Button variant="ghost" onClick={async () => {
                  const fixed = await recomputeAllStock();
                  toast({ tone: "ok", message: fixed ? `Se corrigió el stock de ${fixed} productos.` : "El stock está bien: no hubo que corregir nada." });
                }}>
                  <RefreshCw className="size-5" /> Revisar stock
                </Button>
              </div>
              <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) setPendingBackup(await file.text());
              }} />
            </Card>
          </>
        )}
      </div>

      <Modal
        open={pendingBackup !== null}
        onClose={() => setPendingBackup(null)}
        title="Restaurar copia"
        footer={
          <>
            <Button onClick={() => setPendingBackup(null)}>Cancelar</Button>
            <Button variant="danger" onClick={async () => {
              try {
                await importBackup(pendingBackup!);
                toast({ tone: "ok", message: "Copia restaurada." });
              } catch (e) {
                toast({ tone: "error", message: e instanceof Error ? e.message : "No se pudo leer la copia." });
              }
              setPendingBackup(null);
            }}>Reemplazar mis datos</Button>
          </>
        }
      >
        <p className="text-lg">Esto <b>reemplaza todos los datos de este dispositivo</b> (productos, ventas y cajas) por los de la copia. No se puede deshacer.</p>
      </Modal>
    </div>
  );
}

// --- Nube: cuenta y dispositivos ---

function CloudCard() {
  const cloud = useLiveQuery(getCloudLink, []);
  const sync = useSyncStatus();
  const [mode, setMode] = useState<"registro" | "login" | null>(null);
  const [devices, setDevices] = useState<LinkedDevice[] | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const toast = useToast();

  const loadDevices = async () => {
    try {
      setDevices(await listDevices());
    } catch {
      setDevices(null);
    }
  };
  useEffect(() => {
    if (cloud) void loadDevices();
  }, [cloud, sync.lastSyncAt]);

  if (!cloud && !serverConfigured()) {
    return (
      <Card>
        <h2 className="mb-1 flex items-center gap-2 text-xl font-bold"><Cloud className="size-6 text-brand" /> Usar en varios dispositivos</h2>
        <p className="text-muted">Esta copia de la app de escritorio se armó sin la dirección del servidor, así que funciona sola en este equipo. Para sincronizar, hay que instalar una versión armada con la dirección de tu servidor.</p>
      </Card>
    );
  }

  if (!cloud) {
    return (
      <Card>
        <h2 className="mb-1 flex items-center gap-2 text-xl font-bold"><Cloud className="size-6 text-brand" /> Usar en varios dispositivos</h2>
        <p className="mb-4 text-muted">
          Creá una cuenta para tener los mismos productos, ventas y fiados en la PC del mostrador y en tu celular, y para tener una copia segura en la nube. Sin internet todo sigue funcionando.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setMode("registro")}>Crear cuenta</Button>
          <Button onClick={() => setMode("login")}>Ya tengo cuenta</Button>
        </div>
        <AccountDialog mode={mode} onClose={() => setMode(null)} />
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="mb-1 flex items-center gap-2 text-xl font-bold"><Cloud className="size-6 text-brand" /> Sincronización</h2>
      <p className="mb-4 text-muted">Cuenta <b className="text-ink">{cloud.email}</b> · esta caja es <b className="text-ink">{cloud.prefix}</b></p>
      <p className="mb-4 text-lg" role="status">
        {sync.state === "syncing" ? "Sincronizando…"
          : sync.state === "revoked" ? "Este dispositivo fue desvinculado. Volvé a iniciar sesión para sincronizar."
          : sync.state === "offline" ? `Sin internet. ${sync.pending ? `${sync.pending} cambios esperan para subir.` : "Todo se guarda igual."}`
          : sync.state === "error" ? `No se pudo sincronizar: ${sync.message ?? ""}`
          : `Todo sincronizado${sync.lastSyncAt ? ` a las ${formatTime(sync.lastSyncAt)}` : ""}.`}
      </p>
      <div className="mb-5 flex flex-wrap gap-2">
        <Button onClick={() => void syncNow().then(loadDevices)}><RefreshCw className="size-5" /> Sincronizar ahora</Button>
        <Button variant="ghost" onClick={() => setConfirmUnlink(true)}>Desvincular este dispositivo</Button>
        {sync.state === "revoked" && <Button variant="primary" onClick={() => setMode("login")}>Iniciar sesión</Button>}
      </div>

      {devices && (
        <>
          <h3 className="mb-2 font-bold">Dispositivos vinculados</h3>
          <ul className="divide-y divide-line">
            {devices.filter((d) => !d.revoked).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span className="flex items-center gap-3">
                  <Laptop className="size-5 text-muted" />
                  <span>
                    <b>{d.name}</b> <span className="text-muted">· {d.prefix}{d.current ? " · este" : ""}</span>
                    <span className="block text-sm text-muted">{d.lastSeenAt ? `Última vez: ${formatDateTime(new Date(d.lastSeenAt))}` : "Nunca sincronizó"}</span>
                  </span>
                </span>
                {!d.current && (
                  <Button variant="ghost" onClick={async () => {
                    await revokeDevice(d.id);
                    toast({ tone: "ok", message: `Desvinculaste ${d.name}. Ya no puede sincronizar.` });
                    void loadDevices();
                  }}>Desvincular</Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <AccountDialog mode={mode} onClose={() => setMode(null)} />
      <Modal open={confirmUnlink} onClose={() => setConfirmUnlink(false)} title="Desvincular este dispositivo" footer={
        <>
          <Button onClick={() => setConfirmUnlink(false)}>Cancelar</Button>
          <Button variant="danger" onClick={async () => { await unlink(); setConfirmUnlink(false); }}>Desvincular</Button>
        </>
      }>
        <p className="text-lg">Este dispositivo deja de sincronizar. Los datos que ya tiene quedan guardados acá. {sync.pending > 0 && <b>Hay {sync.pending} cambios sin subir que no van a llegar a los otros dispositivos.</b>}</p>
      </Modal>
    </Card>
  );
}

export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "Celular Android";
  if (/iphone|ipad/i.test(ua)) return "iPhone o iPad";
  return "Computadora del mostrador";
}

export function AccountDialog({ mode, onClose, onLinked }: { mode: "registro" | "login" | null; onClose: () => void; onLinked?: () => void }) {
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!mode) return;
    setError(null);
    setPassword("");
    void db.business.get("business").then((b) => setBusinessName((n) => n || b?.businessName || ""));
  }, [mode]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "registro") await registerAccount({ businessName: businessName || "Mi kiosco", email, password, deviceName });
      else await loginAccount({ email, password, deviceName });
      toast({ tone: "ok", message: mode === "registro" ? "¡Listo! Tus datos ya se están subiendo." : "Dispositivo vinculado. Bajando tus datos…" });
      onClose();
      onLinked?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo conectar. Revisá la conexión a internet.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={mode !== null} onClose={onClose} title={mode === "registro" ? "Crear cuenta" : "Iniciar sesión"} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !email || password.length < (mode === "registro" ? 8 : 1)}>
          {busy ? "Conectando…" : mode === "registro" ? "Crear cuenta" : "Entrar"}
        </Button>
      </>
    }>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {mode === "login" && <p className="text-muted">Los productos y ventas de este dispositivo se suman a los de tu cuenta.</p>}
        {mode === "registro" && (
          <Field label="Nombre del kiosco"><TextInput value={businessName} onChange={(e) => setBusinessName(e.target.value)} /></Field>
        )}
        <Field label="Email"><TextInput type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Contraseña" hint={mode === "registro" ? "Al menos 8 caracteres." : undefined}>
          <TextInput type="password" autoComplete={mode === "registro" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Nombre de este dispositivo" hint="Para reconocerlo en la lista de dispositivos.">
          <TextInput value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </Field>
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// --- Usuarios ---

function UsersCard() {
  const users = useUsers();
  const [editing, setEditing] = useState<User | "nuevo" | null>(null);
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">Usuarios</h2>
        <Button onClick={() => setEditing("nuevo")}><Plus className="size-5" /> Nuevo usuario</Button>
      </div>
      <p className="mb-3 text-muted">Cada persona entra con su nombre y su PIN. Los cajeros venden y cobran; no pueden anular, hacer descuentos ni ver costos.</p>
      <ul className="divide-y divide-line">
        {users.map((u) => (
          <li key={u.id}>
            <button type="button" onClick={() => setEditing(u)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-surface-2">
              <UserRound className="size-5 text-muted" />
              <span className="flex-1">
                <b className={u.active ? "" : "text-muted line-through"}>{u.name}</b>
                <span className="text-muted"> · {ROLE_LABELS[u.role]}{u.active ? "" : " · inactivo"}</span>
              </span>
              <span className="flex items-center gap-1 text-sm text-muted">
                <KeyRound className="size-4" /> {u.pinHash ? "Con PIN" : "Sin PIN"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <UserDialog user={editing === "nuevo" ? null : editing} open={editing !== null} users={users} onClose={() => setEditing(null)} />
    </Card>
  );
}

function UserDialog({ user, open, users, onClose }: { user: User | null; open: boolean; users: User[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("cajero");
  const [pin, setPin] = useState("");
  const [removePin, setRemovePin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setName(user?.name ?? "");
    setRole(user?.role ?? "cajero");
    setPin("");
    setRemovePin(false);
    setError(null);
  }, [open, user]);

  const owners = users.filter((u) => u.active && u.role === "dueno");
  const lastOwner = user?.role === "dueno" && owners.length === 1;

  const save = async () => {
    if (!name.trim()) return setError("Poné un nombre.");
    if (pin && !isValidPin(pin)) return setError("El PIN tiene que tener 4 números.");
    if (lastOwner && role !== "dueno") return setError("Tiene que quedar al menos un dueño.");
    if (user) await updateUser(user.id, { name, role, pin: removePin ? null : pin || undefined });
    else await createUser({ name, role, pin: pin || null });
    toast({ tone: "ok", message: `Guardaste a ${name.trim()}` });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={user ? "Editar usuario" : "Nuevo usuario"} footer={
      <>
        {user && !lastOwner && (
          <Button variant="ghost" className="mr-auto" onClick={async () => { await updateUser(user.id, { active: !user.active }); onClose(); }}>
            {user.active ? "Desactivar" : "Reactivar"}
          </Button>
        )}
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={save}>Guardar</Button>
      </>
    }>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Nombre"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Rol" group>
          <Segmented label="Rol" value={role} onChange={setRole} options={(["cajero", "encargado", "dueno"] as Role[]).map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
        </Field>
        <Field label={user?.pinHash ? "Nuevo PIN (dejalo vacío para no cambiarlo)" : "PIN de 4 números"} hint="Se pide al entrar. Sin PIN, cualquiera puede entrar con este usuario.">
          <TextInput inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} disabled={removePin} />
        </Field>
        {user?.pinHash && <Toggle checked={removePin} onChange={setRemovePin} label="Quitar el PIN" />}
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 font-semibold text-danger">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Campo que guarda al salir, sin botón "Guardar". */
function SettingText({ label, value, hint, onSave }: { label: string; value: string; hint?: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Field label={label} hint={hint}>
      <TextInput value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() !== value && onSave(text.trim())} />
    </Field>
  );
}
