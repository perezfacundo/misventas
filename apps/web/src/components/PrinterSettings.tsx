import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import type { PrinterConfig, Settings } from "../db";
import { saveSettings } from "../data/settings";
import { isDesktop, listSystemPrinters, type SystemPrinter } from "../print/desktop";
import { printTestPage } from "./Ticket";
import { Button, Field, inputClass, Segmented, TextInput, Toggle, useToast } from "./ui";

/** Impresora de tickets de este dispositivo. La impresión directa solo existe en la app de escritorio. */
export function PrinterSettings({ settings }: { settings: Settings }) {
  const toast = useToast();
  const [printers, setPrinters] = useState<SystemPrinter[] | null>(null);
  const [host, setHost] = useState(settings.printer.host);
  const desktop = isDesktop();
  const config = settings.printer;
  const save = (patch: Partial<PrinterConfig>) => void saveSettings({ printer: { ...config, ...patch } });

  useEffect(() => {
    if (desktop && config.mode === "sistema") void listSystemPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [desktop, config.mode]);
  useEffect(() => setHost(config.host), [config.host]);

  if (!desktop) {
    return (
      <p className="rounded-xl bg-surface-2 px-4 py-3 text-muted">
        Desde el navegador el ticket se imprime con la ventana de impresión. Con la <b className="text-ink">app de escritorio</b> sale directo en la ticketera, sin ventanas, y puede abrir el cajón de dinero.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label="¿Cómo imprime esta caja?" group>
        <Segmented
          label="Modo de impresión"
          value={config.mode}
          onChange={(mode) => save({ mode })}
          options={[
            { value: "sistema", label: "Ticketera USB" },
            { value: "red", label: "Ticketera de red" },
            { value: "navegador", label: "Ventana de impresión" },
          ]}
        />
      </Field>
      {config.mode === "sistema" && (
        <Field label="Impresora" hint={printers && !printers.length ? "No se encontraron impresoras. Instalá la ticketera en el sistema y volvé a entrar." : "La ticketera tiene que estar instalada en el sistema operativo."}>
          <select className={inputClass} value={config.name} onChange={(e) => save({ name: e.target.value })}>
            <option value="">Elegí una…</option>
            {(printers ?? []).map((p) => <option key={p.name} value={p.name}>{p.label}{p.is_default ? " (predeterminada)" : ""}</option>)}
          </select>
        </Field>
      )}
      {config.mode === "red" && (
        <Field label="Dirección de la ticketera" hint="La IP que imprime la ticketera en su hoja de prueba. Puerto 9100 si no se indica otro.">
          <TextInput value={host} onChange={(e) => setHost(e.target.value)} onBlur={() => host.trim() !== config.host && save({ host: host.trim() })} placeholder="192.168.0.50" />
        </Field>
      )}
      {config.mode !== "navegador" && (
        <>
          <Toggle checked={config.openDrawer} onChange={(openDrawer) => save({ openDrawer })} label="Abrir el cajón al cobrar en efectivo" hint="Para cajones conectados a la ticketera." />
          <Button className="self-start" onClick={async () => {
            try {
              await printTestPage(settings);
              toast({ tone: "ok", message: "Ticket de prueba enviado." });
            } catch (e) {
              toast({ tone: "error", message: e instanceof Error ? e.message : String(e) });
            }
          }}>
            <Printer className="size-5" /> Imprimir prueba
          </Button>
        </>
      )}
    </div>
  );
}
