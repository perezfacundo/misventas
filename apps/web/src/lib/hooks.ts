import { useCallback, useEffect, useState } from "react";
import { emptyCart, type Cart } from "@misventas/core";

export type Route = "vender" | "hoy" | "productos" | "caja" | "ventas" | "clientes" | "proveedores" | "promociones" | "reportes" | "ajustes";
const ROUTES: Route[] = ["vender", "hoy", "productos", "caja", "ventas", "clientes", "proveedores", "promociones", "reportes", "ajustes"];

const readHash = (): Route => {
  const r = window.location.hash.replace(/^#\/?/, "") as Route;
  return ROUTES.includes(r) ? r : "vender";
};

export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(readHash);
  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = useCallback((r: Route) => {
    window.location.hash = `/${r}`;
  }, []);
  return [route, navigate];
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const CART_KEY = "misventas:carrito";

/** El carrito en curso sobrevive a un cierre accidental de la app. */
export function usePersistentCart(): [Cart, (updater: Cart | ((c: Cart) => Cart)) => void] {
  const [cart, setCart] = useState<Cart>(() => {
    try {
      const raw = localStorage.getItem(CART_KEY);
      return raw ? (JSON.parse(raw) as Cart) : emptyCart();
    } catch {
      return emptyCart();
    }
  });
  useEffect(() => {
    try {
      if (cart.lines.length) localStorage.setItem(CART_KEY, JSON.stringify(cart));
      else localStorage.removeItem(CART_KEY);
    } catch {
      // Sin localStorage el carrito igual funciona, solo no se recupera.
    }
  }, [cart]);
  return [cart, setCart];
}

/** Atajos globales de teclado (F2, F12...). */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const handler = map[e.key];
      if (handler) handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

export const isTypingTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
