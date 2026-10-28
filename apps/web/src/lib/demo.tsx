import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { api, serverConfigured } from "../sync/engine";

const KEY = "misventas:demo";

const readCached = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * ¿Es la versión de prueba pública? Lo decide el servidor (DEMO_MODE=1). Se recuerda el último valor
 * para mostrar el aviso también sin internet.
 */
export function useDemoMode(): boolean {
  const [demo, setDemo] = useState(readCached);
  useEffect(() => {
    if (!serverConfigured()) return;
    api<{ demo: boolean }>("/api/info")
      .then(({ demo: value }) => {
        setDemo(value);
        try {
          if (value) localStorage.setItem(KEY, "1");
          else localStorage.removeItem(KEY);
        } catch {
          // Sin localStorage solo se pierde el aviso sin conexión.
        }
      })
      .catch(() => {
        // Sin conexión: queda el último valor conocido.
      });
  }, []);
  return demo;
}

export function DemoBanner() {
  const demo = useDemoMode();
  if (!demo) return null;
  return (
    <div role="note" className="flex items-center justify-center gap-2 bg-warn-soft px-4 py-1.5 text-center text-sm font-semibold text-warn">
      <FlaskConical className="size-4 shrink-0" />
      Versión de prueba: los datos pueden borrarse. No la uses todavía para tu negocio real.
    </div>
  );
}
