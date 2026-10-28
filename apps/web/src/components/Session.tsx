import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Delete, Lock, UserRound } from "lucide-react";
import { can, ROLE_LABELS, type Permission } from "@misventas/core";
import type { User } from "../db";
import { createUser, useUsers } from "../data/users";
import { verifyPin, isValidPin } from "../lib/pin";
import { Button, cx, Field, TextInput } from "./ui";

const KEY = "misventas:usuario";

interface SessionValue {
  user: User;
  can: (p: Permission) => boolean;
  /** Vuelve a la pantalla "¿Quién atiende?". */
  lock: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession fuera de SessionGate");
  return s;
}

const readStored = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** Muestra la app solo cuando se sabe quién atiende. Cada persona entra con su usuario (y PIN si tiene). */
export function SessionGate({ children }: { children: ReactNode }) {
  const users = useUsers();
  const [userId, setUserId] = useState<string | null>(readStored);
  const active = users.filter((u) => u.active);

  const select = useCallback((id: string | null) => {
    setUserId(id);
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch {
      // Sin localStorage hay que elegir usuario en cada apertura.
    }
  }, []);

  // Con un único usuario sin PIN no hace falta preguntar.
  useEffect(() => {
    const only = active.length === 1 ? active[0] : undefined;
    if (!userId && only && !only.pinHash) select(only.id);
  }, [active, userId, select]);

  const user = active.find((u) => u.id === userId);
  const value = useMemo<SessionValue | null>(
    // Al cambiar de usuario se vuelve a Vender: quien toma el turno arranca vendiendo.
    () => (user ? { user, can: (p) => can(user.role, p), lock: () => { select(null); window.location.hash = "/vender"; } } : null),
    [user, select],
  );

  if (!value) return <UserPicker users={active} onSelect={select} />;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function UserPicker({ users, onSelect }: { users: User[]; onSelect: (id: string) => void }) {
  const [pinFor, setPinFor] = useState<User | null>(null);
  if (users.length === 0) return <FirstUser onCreated={onSelect} />;
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-4">
      <div className="w-full max-w-2xl">
        <img src="/icon.svg" alt="" className="mx-auto mb-6 size-14" />
        {pinFor ? (
          <PinPad user={pinFor} onBack={() => setPinFor(null)} onOk={() => onSelect(pinFor.id)} />
        ) : (
          <>
            <h1 className="mb-6 text-center text-3xl font-extrabold">¿Quién atiende?</h1>
            <div className="grid gap-3 sm:grid-cols-2">
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => (u.pinHash ? setPinFor(u) : onSelect(u.id))}
                  className="flex min-h-20 items-center gap-4 rounded-2xl border border-line bg-surface px-5 text-left shadow-sm hover:border-brand"
                >
                  <span className="grid size-12 place-items-center rounded-full bg-brand-soft text-xl font-bold">{u.name.charAt(0).toUpperCase()}</span>
                  <span className="flex-1">
                    <span className="block text-xl font-bold">{u.name}</span>
                    <span className="text-muted">{ROLE_LABELS[u.role]}</span>
                  </span>
                  {u.pinHash && <Lock className="size-5 text-muted" aria-label="Con PIN" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PinPad({ user, onBack, onOk }: { user: User; onBack: () => void; onOk: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);

  const press = useCallback((d: string) => {
    setError(false);
    setPin((p) => (p.length < 4 ? p + d : p));
  }, []);

  useEffect(() => {
    if (pin.length !== 4) return;
    let cancelled = false;
    void verifyPin(pin, user.pinHash!).then((ok) => {
      if (cancelled) return;
      if (ok) onOk();
      else {
        setError(true);
        setPin("");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pin, user.pinHash, onOk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, onBack]);

  return (
    <div className="mx-auto max-w-sm text-center">
      <h1 className="text-3xl font-extrabold">Hola, {user.name}</h1>
      <p className="mt-1 text-lg text-muted">Ingresá tu PIN</p>
      <div className="my-6 flex justify-center gap-3" aria-live="polite" aria-label={`${pin.length} de 4 dígitos`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cx("size-5 rounded-full border-2", i < pin.length ? "border-brand bg-brand" : "border-line", error && "border-danger")} />
        ))}
      </div>
      {error && <p role="alert" className="mb-4 font-semibold text-danger">PIN incorrecto. Probá de nuevo.</p>}
      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" onClick={() => press(d)} className="num min-h-18 rounded-2xl border border-line bg-surface text-3xl font-bold hover:bg-surface-2">
            {d}
          </button>
        ))}
        <button type="button" onClick={onBack} className="min-h-18 rounded-2xl text-lg font-semibold text-muted hover:bg-surface-2">Volver</button>
        <button type="button" onClick={() => press("0")} className="num min-h-18 rounded-2xl border border-line bg-surface text-3xl font-bold hover:bg-surface-2">0</button>
        <button type="button" onClick={() => setPin((p) => p.slice(0, -1))} className="grid min-h-18 place-items-center rounded-2xl text-muted hover:bg-surface-2" aria-label="Borrar">
          <Delete className="size-7" />
        </button>
      </div>
    </div>
  );
}

/** Caso raro: el comercio no tiene usuarios (por ejemplo, un dispositivo recién vinculado antes de bajar los datos). */
function FirstUser({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const submit = async () => {
    if (!name.trim() || (pin && !isValidPin(pin))) return;
    const user = await createUser({ name, role: "dueno", pin: pin || null });
    onCreated(user.id);
  };
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-4">
      <form className="w-full max-w-md rounded-3xl border border-line bg-surface p-8" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <UserRound className="mb-4 size-10 text-brand" />
        <h1 className="mb-6 text-2xl font-extrabold">Creá tu usuario</h1>
        <div className="flex flex-col gap-4">
          <Field label="Tu nombre"><TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="PIN de 4 números (opcional)"><TextInput inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} /></Field>
          <Button type="submit" variant="primary" size="lg" disabled={!name.trim() || (pin !== "" && !isValidPin(pin))}>Entrar</Button>
        </div>
      </form>
    </div>
  );
}
