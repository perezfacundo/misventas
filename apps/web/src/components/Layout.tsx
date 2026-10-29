import { useState, type ReactNode } from "react";
import {
  BadgePercent, BarChart3, CloudOff, CloudUpload, LineChart, Menu, Package, Receipt, RefreshCw, Settings as SettingsIcon,
  ShoppingCart, Truck, UserRound, Users, Wallet, Wifi, WifiOff, type LucideIcon,
} from "lucide-react";
import type { Permission } from "@misventas/core";
import type { Route } from "../lib/hooks";
import { useNow, useOnline } from "../lib/hooks";
import { useOpenSession } from "../data/cash";
import { useSyncStatus, type SyncStatus } from "../sync/engine";
import { formatTime } from "../lib/format";
import { cx, Modal } from "./ui";
import { useSession } from "./Session";
import { branchName, hasMultipleBranches, useBranches } from "../data/branches";
import { currentBranchId } from "../db";
import { DemoBanner } from "../lib/demo";

interface NavItem {
  route: Route;
  label: string;
  icon: LucideIcon;
  /** Aparece en la barra inferior del celular; el resto va en "Más". */
  primary: boolean;
  permission?: Permission;
}

const NAV: NavItem[] = [
  { route: "vender", label: "Vender", icon: ShoppingCart, primary: true },
  { route: "hoy", label: "Hoy", icon: BarChart3, primary: true },
  { route: "productos", label: "Productos", icon: Package, primary: true },
  { route: "caja", label: "Caja", icon: Wallet, primary: true },
  { route: "ventas", label: "Ventas", icon: Receipt, primary: false },
  { route: "clientes", label: "Fiado", icon: Users, primary: false },
  { route: "proveedores", label: "Proveedores", icon: Truck, primary: false, permission: "gestionarProveedores" },
  { route: "promociones", label: "Promos", icon: BadgePercent, primary: false, permission: "editarProductos" },
  { route: "reportes", label: "Reportes", icon: LineChart, primary: false, permission: "verReportes" },
  { route: "ajustes", label: "Ajustes", icon: SettingsIcon, primary: false },
];

export function Layout({ route, navigate, businessName, children }: {
  route: Route;
  navigate: (r: Route) => void;
  businessName: string;
  children: ReactNode;
}) {
  const online = useOnline();
  const session = useOpenSession();
  const sync = useSyncStatus();
  const { user, can, lock } = useSession();
  const now = useNow();
  const [more, setMore] = useState(false);
  const branches = useBranches();
  const items = NAV.filter((n) => !n.permission || can(n.permission));
  const mobileMain = items.filter((n) => n.primary);
  const mobileMore = items.filter((n) => !n.primary);

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      {/* Barra lateral: tablet y PC */}
      <nav aria-label="Principal" className="hidden md:flex w-24 lg:w-28 shrink-0 flex-col items-stretch gap-0.5 overflow-y-auto border-r border-line bg-surface px-2 py-3">
        <img src="/icon.svg" alt="" className="mx-auto mb-3 size-10" />
        {items.map(({ route: r, label, icon: Icon }) => (
          <button
            key={r}
            type="button"
            onClick={() => navigate(r)}
            aria-current={route === r ? "page" : undefined}
            className={cx(
              "flex flex-col items-center gap-1 rounded-2xl px-1 py-2.5 text-sm font-semibold transition-colors",
              route === r ? "bg-brand-soft text-ink" : "text-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            <Icon className={cx("size-6", route === r && "text-brand")} strokeWidth={route === r ? 2.4 : 2} />
            {label}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DemoBanner />
        {/* Barra de estado: tranquila, siempre visible */}
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2 text-sm sm:text-base">
          <span className="hidden truncate font-bold sm:inline">
            {businessName || "Mis Ventas"}
            {hasMultipleBranches(branches) && <span className="font-normal text-muted"> · {branchName(branches, currentBranchId())}</span>}
          </span>
          <ConnectionStatus online={online} sync={sync} />
          <span className="ml-auto" />
          <button type="button" onClick={() => navigate("caja")} className="truncate text-muted hover:text-ink">
            {session ? <>Caja <b className="text-ink">abierta</b></> : <span className="font-semibold text-warn">Caja cerrada</span>}
          </button>
          <span className="text-line">|</span>
          <button type="button" onClick={lock} className="flex items-center gap-1.5 truncate rounded-lg px-1.5 py-0.5 hover:bg-surface-2" title="Cambiar de usuario">
            <UserRound className="size-4 text-muted" /> <b>{user.name}</b>
          </button>
          <span className="num hidden text-muted lg:inline">{formatTime(now)}</span>
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>

        {/* Barra inferior: celular */}
        <nav aria-label="Principal" className="md:hidden grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
          {mobileMain.map(({ route: r, label, icon: Icon }) => (
            <button
              key={r}
              type="button"
              onClick={() => navigate(r)}
              aria-current={route === r ? "page" : undefined}
              className={cx("flex flex-col items-center gap-0.5 py-2 text-xs font-semibold", route === r ? "text-brand" : "text-muted")}
            >
              <Icon className="size-6" strokeWidth={route === r ? 2.4 : 2} />
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMore(true)}
            className={cx("flex flex-col items-center gap-0.5 py-2 text-xs font-semibold", mobileMore.some((n) => n.route === route) ? "text-brand" : "text-muted")}
          >
            <Menu className="size-6" /> Más
          </button>
        </nav>
      </div>

      <Modal open={more} onClose={() => setMore(false)} title="Más opciones">
        <div className="grid grid-cols-2 gap-3">
          {mobileMore.map(({ route: r, label, icon: Icon }) => (
            <button
              key={r}
              type="button"
              onClick={() => { setMore(false); navigate(r); }}
              className={cx("flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border text-lg font-semibold", route === r ? "border-brand bg-brand-soft" : "border-line")}
            >
              <Icon className="size-7" /> {label}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/** Conexión y sincronización en una sola frase corta, sin alarmas. */
function ConnectionStatus({ online, sync }: { online: boolean; sync: SyncStatus }) {
  let icon = <Wifi className="size-4 text-brand" />;
  let text = online ? "En línea" : "Sin internet";
  let long = online ? "En línea" : "Sin internet: tus ventas se guardan igual";
  if (sync.state === "syncing") {
    icon = <RefreshCw className="size-4 animate-spin text-brand" />;
    text = long = "Sincronizando…";
  } else if (sync.state === "idle") {
    text = "Sincronizado";
    long = "Sincronizado con tus otros dispositivos";
  } else if (sync.state === "offline" || !online) {
    icon = <WifiOff className="size-4 text-warn" />;
    text = "Sin internet";
    long = sync.pending ? `Sin internet: ${sync.pending} cambios esperan para subir` : "Sin internet: tus ventas se guardan igual";
  } else if (sync.state === "error") {
    icon = <CloudUpload className="size-4 text-warn" />;
    text = "Reintentando";
    long = "No se pudo sincronizar, se reintenta solo";
  } else if (sync.state === "revoked") {
    icon = <CloudOff className="size-4 text-danger" />;
    text = long = "Desvinculado";
  }
  return (
    <span className="flex items-center gap-1.5 text-muted" role="status">
      {icon}
      <span className="hidden sm:inline">{long}</span>
      <span className="sm:hidden">{text}</span>
    </span>
  );
}
