import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import QRCode from "qrcode";
import { CBTE_LABELS, DOC, formatInvoiceNumber, formatMoney, lineTotal, PAYMENT_LABELS } from "@misventas/core";
import type { IssuedInvoice, Sale, Settings } from "../db";
import { formatDateTime } from "../lib/format";
import { drawerBytes, invoiceTexts, testPageBytes, ticketBytes } from "../print/escpos";
import { isDesktop, printToNetwork, printToSystem } from "../print/desktop";

const row = { display: "flex", justifyContent: "space-between", gap: 8 } as const;
const rule = <hr style={{ border: 0, borderTop: "1px dashed #000" }} />;

function Ticket({ sale, settings, invoice, original, qrDataUrl }: {
  sale: Sale;
  settings: Settings;
  invoice?: IssuedInvoice;
  original?: IssuedInvoice;
  qrDataUrl?: string;
}) {
  const width = settings.paperWidth === 80 ? "72mm" : "48mm";
  const fiscal = invoice ? invoiceTexts(invoice) : null;
  return (
    <div style={{ width, fontFamily: "ui-monospace, monospace", fontSize: settings.paperWidth === 80 ? "12px" : "10.5px", lineHeight: 1.35, color: "#000" }}>
      <style>{`@page { size: ${settings.paperWidth}mm auto; margin: 3mm; }`}</style>
      <div style={{ textAlign: "center", marginBottom: 6 }}>
        <div style={{ fontWeight: 700, fontSize: "1.3em" }}>{invoice?.issuer.razonSocial || settings.businessName || "Mis Ventas"}</div>
        {fiscal ? fiscal.issuer.map((l) => <div key={l}>{l}</div>) : (
          <>
            {settings.address && <div>{settings.address}</div>}
            {settings.taxId && <div>CUIT {settings.taxId}</div>}
          </>
        )}
      </div>
      {fiscal ? (
        <>
          {rule}
          <div style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 700, fontSize: "1.4em" }}>{fiscal.title}</div>
            <div>{fiscal.code}</div>
          </div>
          <div>{fiscal.number}</div>
          <div>{fiscal.date}</div>
          {original && <div>Anula {CBTE_LABELS[original.cbteTipo]} {formatInvoiceNumber(original.ptoVta, original.numero ?? 0)}</div>}
          {fiscal.test && <div style={{ fontWeight: 700 }}>PRUEBA - SIN VALIDEZ FISCAL</div>}
          <div>{fiscal.receiver}</div>
          {invoice!.receiver.docTipo !== DOC.CONSUMIDOR_FINAL && <div>{fiscal.receiverCondition}</div>}
          <div>Atendió: {sale.cashier} · Venta {sale.number}</div>
        </>
      ) : (
        <>
          <div>Comprobante N.º {sale.number}</div>
          <div>{formatDateTime(sale.createdAt)} · Atendió: {sale.cashier}</div>
          <div style={{ fontWeight: 700, margin: "4px 0" }}>NO VÁLIDO COMO FACTURA</div>
        </>
      )}
      {rule}
      {sale.items.map((l) => (
        <div key={l.lineId} style={{ marginBottom: 2 }}>
          <div>{l.name}</div>
          <div style={row}>
            <span>{l.quantity} x {formatMoney(l.unitPrice)}</span>
            <span>{formatMoney(lineTotal(l))}</span>
          </div>
        </div>
      ))}
      {rule}
      {sale.discount > 0 && <div style={row}><span>Descuento</span><span>−{formatMoney(sale.discount)}</span></div>}
      <div style={{ ...row, fontWeight: 700, fontSize: "1.3em" }}>
        <span>TOTAL</span>
        <span>{formatMoney(sale.total)}</span>
      </div>
      {sale.payments.map((p, i) => (
        <div key={i} style={row}><span>{PAYMENT_LABELS[p.method]}</span><span>{formatMoney(p.tendered ?? p.amount)}</span></div>
      ))}
      {sale.change > 0 && <div style={row}><span>Vuelto</span><span>{formatMoney(sale.change)}</span></div>}
      {fiscal ? (
        <>
          {fiscal.ivaLines.length > 0 && (
            <>
              {rule}
              {fiscal.ivaLines.map(([label, value]) => <div key={label} style={row}><span>{label}</span><span>{value}</span></div>)}
            </>
          )}
          {fiscal.transparency && (
            <>
              {rule}
              <div>{fiscal.transparency.legend}</div>
              <div style={row}><span>IVA contenido</span><span>{fiscal.transparency.iva}</span></div>
              <div style={row}><span>Otros imp. nac. indirectos</span><span>{fiscal.transparency.others}</span></div>
            </>
          )}
          {rule}
          <div>{fiscal.cae}</div>
          <div>{fiscal.caeVto}</div>
          {qrDataUrl && (
            <div style={{ textAlign: "center", marginTop: 6 }}>
              <img src={qrDataUrl} alt="" style={{ width: "32mm", height: "32mm" }} />
              <div>Comprobante autorizado por ARCA</div>
            </div>
          )}
        </>
      ) : (
        sale.status === "anulada" && <div style={{ fontWeight: 700, textAlign: "center", marginTop: 6 }}>*** ANULADA ***</div>
      )}
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
export async function printTicket(
  sale: Sale,
  settings: Settings,
  opts: { openDrawer?: boolean; invoice?: IssuedInvoice; original?: IssuedInvoice } = {},
): Promise<void> {
  // Solo un comprobante autorizado sale como fiscal; si no, va el ticket interno.
  const invoice = opts.invoice?.status === "autorizada" ? opts.invoice : undefined;
  if (printsDirect(settings)) {
    await sendRaw(settings, ticketBytes(sale, settings, { openDrawer: opts.openDrawer && settings.printer.openDrawer, invoice, original: opts.original }));
    return;
  }
  const container = document.getElementById("print-root");
  if (!container) return;
  const qrDataUrl = invoice?.qrUrl ? await QRCode.toDataURL(invoice.qrUrl, { margin: 0, width: 240, errorCorrectionLevel: "M" }) : undefined;
  const root = createRoot(container);
  flushSync(() => root.render(<Ticket sale={sale} settings={settings} invoice={invoice} original={opts.original} qrDataUrl={qrDataUrl} />));
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
