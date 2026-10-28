import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { formatMoney, lineTotal, PAYMENT_LABELS } from "@misventas/core";
import type { Sale, Settings } from "../db";
import { formatDateTime } from "../lib/format";
import { drawerBytes, testPageBytes, ticketBytes } from "../print/escpos";
import { isDesktop, printToNetwork, printToSystem } from "../print/desktop";

function Ticket({ sale, settings }: { sale: Sale; settings: Settings }) {
  const width = settings.paperWidth === 80 ? "72mm" : "48mm";
  return (
    <div style={{ width, fontFamily: "ui-monospace, monospace", fontSize: settings.paperWidth === 80 ? "12px" : "10.5px", lineHeight: 1.35, color: "#000" }}>
      <style>{`@page { size: ${settings.paperWidth}mm auto; margin: 3mm; }`}</style>
      <div style={{ textAlign: "center", marginBottom: 6 }}>
        <div style={{ fontWeight: 700, fontSize: "1.3em" }}>{settings.businessName || "Mis Ventas"}</div>
        {settings.address && <div>{settings.address}</div>}
        {settings.taxId && <div>CUIT {settings.taxId}</div>}
      </div>
      <div>Comprobante N.º {sale.number}</div>
      <div>{formatDateTime(sale.createdAt)} · Atendió: {sale.cashier}</div>
      <div style={{ fontWeight: 700, margin: "4px 0" }}>NO VÁLIDO COMO FACTURA</div>
      <hr style={{ border: 0, borderTop: "1px dashed #000" }} />
      {sale.items.map((l) => (
        <div key={l.lineId} style={{ marginBottom: 2 }}>
          <div>{l.name}</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{l.quantity} x {formatMoney(l.unitPrice)}</span>
            <span>{formatMoney(lineTotal(l))}</span>
          </div>
        </div>
      ))}
      <hr style={{ border: 0, borderTop: "1px dashed #000" }} />
      {sale.discount > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Descuento</span>
          <span>−{formatMoney(sale.discount)}</span>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: "1.3em" }}>
        <span>TOTAL</span>
        <span>{formatMoney(sale.total)}</span>
      </div>
      {sale.payments.map((p, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{PAYMENT_LABELS[p.method]}</span>
          <span>{formatMoney(p.tendered ?? p.amount)}</span>
        </div>
      ))}
      {sale.change > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Vuelto</span>
          <span>{formatMoney(sale.change)}</span>
        </div>
      )}
      {sale.status === "anulada" && <div style={{ fontWeight: 700, textAlign: "center", marginTop: 6 }}>*** ANULADA ***</div>}
      {settings.ticketFooter && <div style={{ textAlign: "center", marginTop: 8 }}>{settings.ticketFooter}</div>}
    </div>
  );
}

/** ¿Este dispositivo imprime directo (ESC/POS) en vez de usar la ventana de impresión? */
export const printsDirect = (settings: Settings) => isDesktop() && settings.printer.mode !== "navegador";

async function sendRaw(settings: Settings, data: Uint8Array): Promise<void> {
  const { printer } = settings;
  if (printer.mode === "sistema") {
    if (!printer.name) throw new Error("Elegí la impresora en Ajustes.");
    await printToSystem(printer.name, data);
  } else {
    if (!printer.host) throw new Error("Cargá la dirección de la impresora en Ajustes.");
    await printToNetwork(printer.host, data);
  }
}

/**
 * Imprime el ticket. En la app de escritorio con impresora configurada sale directo en ESC/POS
 * (y puede abrir el cajón); si no, con la ventana de impresión del navegador.
 * Lanza un error con un mensaje para mostrar si la impresora no responde.
 */
export async function printTicket(sale: Sale, settings: Settings, opts: { openDrawer?: boolean } = {}): Promise<void> {
  if (printsDirect(settings)) {
    await sendRaw(settings, ticketBytes(sale, settings, { openDrawer: opts.openDrawer && settings.printer.openDrawer }));
    return;
  }
  const container = document.getElementById("print-root");
  if (!container) return;
  const root = createRoot(container);
  flushSync(() => root.render(<Ticket sale={sale} settings={settings} />));
  window.print();
  root.unmount();
}

/** Abre el cajón sin imprimir (venta en efectivo sin ticket). Solo con impresión directa. */
export async function openCashDrawer(settings: Settings): Promise<void> {
  if (printsDirect(settings) && settings.printer.openDrawer) await sendRaw(settings, drawerBytes());
}

export async function printTestPage(settings: Settings): Promise<void> {
  await sendRaw(settings, testPageBytes(settings));
}
