import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
} from "react";
import { X } from "lucide-react";
import { parseMoney, stockStatus, type Cents } from "@misventas/core";
import { centsToInput } from "../lib/format";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "lg" | "xl";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-brand-ink hover:bg-brand-hover shadow-sm",
  secondary: "bg-surface text-ink border border-line hover:bg-surface-2",
  ghost: "text-ink hover:bg-surface-2",
  danger: "bg-danger-soft text-danger border border-danger/30 hover:bg-danger/15",
};
const SIZES: Record<Size, string> = {
  md: "min-h-12 px-4 text-base gap-2",
  lg: "min-h-14 px-5 text-lg gap-2.5",
  xl: "min-h-18 px-6 text-2xl gap-3",
};

export function Button({
  variant = "secondary", size = "md", className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex items-center justify-center rounded-xl font-semibold transition-colors select-none",
        "disabled:opacity-45 disabled:pointer-events-none active:scale-[0.98]",
        VARIANTS[variant], SIZES[size], className,
      )}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="hidden md:inline-block rounded-md border border-current/25 px-1.5 py-0.5 text-xs font-medium opacity-70">
      {children}
    </kbd>
  );
}

/** Pila de modales abiertos: Escape cierra solo el de arriba. */
const modalStack: symbol[] = [];

export function Modal({
  open, onClose, title, children, footer, wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const me = Symbol("modal");
    modalStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalStack.at(-1) === me) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Foco en el primer campo, o en el diálogo si no hay campos.
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, [data-autofocus]");
    (first ?? ref.current)?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      modalStack.splice(modalStack.indexOf(me), 1);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/45 sm:p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx(
          "flex max-h-[94dvh] w-full flex-col rounded-t-3xl sm:rounded-3xl bg-surface shadow-2xl outline-none",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-xl font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-muted hover:bg-surface-2" aria-label="Cerrar">
            <X className="size-6" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-3 border-t border-line px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Etiqueta + campo. Con `group` (para grupos de botones como Segmented) no usa <label>:
 * un label envolviendo botones les cambia el nombre accesible y al tocarlo activa el primero.
 */
export function Field({ label, hint, group = false, children }: { label: string; hint?: ReactNode; group?: boolean; children: ReactNode }) {
  const id = useId();
  const content = (
    <>
      <span id={id} className="text-sm font-semibold text-muted">{label}</span>
      {children}
      {hint && <span className="text-sm text-muted">{hint}</span>}
    </>
  );
  return group ? (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">{content}</div>
  ) : (
    <label className="flex flex-col gap-1.5">{content}</label>
  );
}

export const inputClass =
  "min-h-12 w-full rounded-xl border border-line bg-surface px-3.5 text-lg text-ink placeholder:text-muted/70 focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/30";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

/** Campo de dinero: acepta "1500", "1.500" o "1500,50" y devuelve centavos. */
export function MoneyInput({
  value, onChange, className, ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: Cents | null;
  onChange: (cents: Cents | null) => void;
}) {
  const [text, setText] = useState(() => centsToInput(value));
  useEffect(() => {
    if (parseMoney(text) !== value) setText(centsToInput(value));
    // Solo sincroniza cuando el valor cambia desde afuera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-lg text-muted">$</span>
      <input
        inputMode="decimal"
        autoComplete="off"
        {...props}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseMoney(e.target.value));
        }}
        className={cx(inputClass, "num pl-8", className)}
      />
    </div>
  );
}

export function Segmented<T extends string | number>({
  value, onChange, options, label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "min-h-12 rounded-xl border px-4 font-semibold transition-colors",
            o.value === value ? "border-brand bg-brand-soft text-ink ring-2 ring-brand/40" : "border-line bg-surface hover:bg-surface-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4">
      <span>
        <span className="font-semibold">{label}</span>
        {hint && <span className="block text-sm text-muted">{hint}</span>}
      </span>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="relative h-8 w-14 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-brand peer-focus-visible:ring-3 peer-focus-visible:ring-focus after:absolute after:left-1 after:top-1 after:size-6 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-6" />
    </label>
  );
}

/** Estado de stock con texto y color: nunca solo color. */
export function StockBadge({ stock, minStock, trackStock }: { stock: number; minStock: number; trackStock: boolean }) {
  if (!trackStock) return <span className="text-sm text-muted">Sin control</span>;
  const status = stockStatus(stock, minStock);
  const styles = {
    ok: "bg-surface-2 text-ink",
    bajo: "bg-warn-soft text-warn",
    agotado: "bg-danger-soft text-danger",
  }[status];
  const label = status === "agotado" ? (stock < 0 ? `Revisar (${stock})` : "Sin stock") : `${stock} u.`;
  return <span className={cx("num inline-flex rounded-lg px-2.5 py-1 text-sm font-semibold whitespace-nowrap", styles)}>{label}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-5">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-lg text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx("rounded-2xl border border-line bg-surface p-5", className)}>{children}</section>;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center text-muted">
      <div className="text-muted/70 [&>svg]:size-12">{icon}</div>
      <p className="text-xl font-semibold text-ink">{title}</p>
      {children && <div className="max-w-sm text-base">{children}</div>}
    </div>
  );
}

// --- Avisos breves (toasts) ---

interface Toast {
  id: number;
  message: ReactNode;
  tone: "ok" | "error";
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.tone === "error" ? 7000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto flex max-w-md items-center gap-4 rounded-2xl px-5 py-3.5 text-base font-semibold shadow-xl",
              t.tone === "ok" ? "bg-ink text-bg" : "bg-danger text-white",
            )}
          >
            <span>{t.message}</span>
            {t.action && (
              <button type="button" onClick={t.action.run} className="rounded-lg px-2 py-1 underline underline-offset-4">
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
