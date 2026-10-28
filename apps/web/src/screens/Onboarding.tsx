import { useState, type ReactNode } from "react";
import { ArrowRight, Cloud, PackageOpen, Sparkles, Store } from "lucide-react";
import type { Cents } from "@misventas/core";
import { saveSettings } from "../data/settings";
import { seedSampleProducts } from "../data/seed";
import { openSession } from "../data/cash";
import { createUser } from "../data/users";
import { isValidPin } from "../lib/pin";
import { Button, cx, Field, MoneyInput, TextInput } from "../components/ui";
import { AccountDialog } from "./Ajustes";

/** Primer uso: o se arranca un kiosco nuevo en tres pasos, o se vincula este dispositivo a una cuenta existente. */
export function Onboarding() {
  const [path, setPath] = useState<"nuevo" | null>(null);
  const [login, setLogin] = useState(false);
  const [step, setStep] = useState(0);
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [pin, setPin] = useState("");
  const [sample, setSample] = useState(true);
  const [opening, setOpening] = useState<Cents | null>(0);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    const owner = await createUser({ name: ownerName, role: "dueno", pin: pin || null });
    try {
      localStorage.setItem("misventas:usuario", owner.id);
    } catch {
      // Sin localStorage se elige el usuario al entrar.
    }
    if (sample) await seedSampleProducts();
    await openSession(owner, opening ?? 0);
    await saveSettings({ businessName: businessName.trim(), onboarded: true });
    window.location.hash = "/vender";
  };

  if (!path) {
    return (
      <Shell>
        <h1 className="mb-2 text-3xl font-extrabold tracking-tight">¡Hola! Bienvenido a Mis Ventas</h1>
        <p className="mb-6 text-lg text-muted">Vendé, cobrá y controlá el stock de tu kiosco, con o sin internet.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Choice selected={false} onClick={() => setPath("nuevo")} icon={<Store />} title="Empiezo acá" text="Es la primera vez que uso Mis Ventas." />
          <Choice selected={false} onClick={() => setLogin(true)} icon={<Cloud />} title="Ya lo uso en otro equipo" text="Iniciar sesión y traer mis productos, ventas y usuarios." />
        </div>
        <AccountDialog mode={login ? "login" : null} onClose={() => setLogin(false)} onLinked={() => void saveSettings({ onboarded: true })} />
      </Shell>
    );
  }

  const steps = [
    {
      title: "Contanos de tu kiosco",
      body: (
        <div className="flex flex-col gap-5">
          <Field label="¿Cómo se llama tu kiosco?">
            <TextInput value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Ej.: Kiosco Don Pepe" autoFocus />
          </Field>
          <Field label="¿Cómo te llamás?" hint="Aparece en los tickets y en el cierre de caja.">
            <TextInput value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Tu nombre" />
          </Field>
          <Field label="Elegí un PIN de 4 números (recomendado)" hint="Así nadie más entra con tu usuario. Podés agregarlo después.">
            <TextInput inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="••••" />
          </Field>
        </div>
      ),
      canNext: businessName.trim() !== "" && ownerName.trim() !== "" && (pin === "" || isValidPin(pin)),
    },
    {
      title: "¿Querés practicar con productos de ejemplo?",
      body: (
        <div className="grid gap-3 sm:grid-cols-2">
          <Choice selected={sample} onClick={() => setSample(true)} icon={<Sparkles />} title="Sí, cargá ejemplos" text="20 productos típicos de kiosco para probar. Los podés borrar o editar después." />
          <Choice selected={!sample} onClick={() => setSample(false)} icon={<PackageOpen />} title="Empiezo de cero" text="Cargás tus productos escaneándolos o importando una planilla de Excel." />
        </div>
      ),
      canNext: true,
    },
    {
      title: "Último paso: abrí la caja",
      body: (
        <Field label="¿Con cuánto efectivo empieza el cajón?" hint="El cambio que tenés ahora. Si no sabés, dejalo en 0.">
          <MoneyInput value={opening} onChange={setOpening} placeholder="0" className="min-h-16 text-3xl font-bold" autoFocus />
        </Field>
      ),
      canNext: true,
    },
  ];
  const current = steps[step]!;
  const last = step === steps.length - 1;

  return (
    <Shell
      onSubmit={() => {
        if (!current.canNext || busy) return;
        if (last) void finish();
        else setStep(step + 1);
      }}
    >
      <p className="mb-1 font-semibold text-muted">Paso {step + 1} de {steps.length}</p>
      <h1 className="mb-6 text-3xl font-extrabold tracking-tight">{current.title}</h1>
      {current.body}
      <div className="mt-8 flex justify-between gap-3">
        <Button size="lg" onClick={() => (step > 0 ? setStep(step - 1) : setPath(null))}>Atrás</Button>
        <Button type="submit" size="lg" variant="primary" disabled={!current.canNext || busy}>
          {last ? "Empezar a vender" : "Siguiente"} <ArrowRight className="size-5" />
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) {
  const className = "w-full max-w-xl rounded-3xl border border-line bg-surface p-6 shadow-xl sm:p-10";
  const content = (
    <>
      <img src="/icon.svg" alt="" className="mb-6 size-14" />
      {children}
    </>
  );
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-4">
      {onSubmit ? (
        <form className={className} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>{content}</form>
      ) : (
        <div className={className}>{content}</div>
      )}
    </div>
  );
}

function Choice({ selected, onClick, icon, title, text }: { selected: boolean; onClick: () => void; icon: ReactNode; title: string; text: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        "flex flex-col gap-2 rounded-2xl border-2 p-5 text-left transition-colors [&>svg]:size-8",
        selected ? "border-brand bg-brand-soft" : "border-line hover:bg-surface-2",
      )}
    >
      {icon}
      <span className="text-lg font-bold">{title}</span>
      <span className="text-muted">{text}</span>
    </button>
  );
}
