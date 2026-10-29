import { useLiveQuery } from "dexie-react-hooks";
import { lineTotal, uuidv7 } from "@misventas/core";
import { db, type InvoiceReceiver, type InvoiceRecord, type IssuedInvoice, type Sale } from "../db";
import { api, ApiError, getCloudLink } from "../sync/engine";

/** Pide la factura de una venta. Queda pendiente y se emite apenas haya conexión con ARCA. */
export async function requestInvoice(sale: Sale, receiver: InvoiceReceiver): Promise<InvoiceRecord> {
  const now = Date.now();
  const record: InvoiceRecord = {
    id: uuidv7(),
    saleId: sale.id,
    kind: "factura",
    status: "pendiente",
    request: {
      lines: sale.items.map((l) => ({ gross: lineTotal(l), ...(l.ivaRate !== undefined ? { ivaRate: l.ivaRate } : {}) })),
      // Las promociones son descuentos: la factura tiene que dar el total cobrado.
      discount: sale.discount + (sale.promotions ?? []).reduce((sum, p) => sum + p.amount, 0),
      receiver,
    },
    createdAt: now,
    updatedAt: now,
  };
  await db.invoices.add(record);
  return record;
}

/** Nota de crédito por el total de una factura autorizada (al anular la venta). */
export async function requestCreditNote(invoice: InvoiceRecord): Promise<InvoiceRecord> {
  const existing = await db.invoices.where("saleId").equals(invoice.saleId).filter((r) => r.kind === "nota_credito" && r.status !== "rechazada").first();
  if (existing) return existing;
  const now = Date.now();
  const record: InvoiceRecord = {
    id: uuidv7(),
    saleId: invoice.saleId,
    kind: "nota_credito",
    status: "pendiente",
    request: invoice.request,
    associatedId: invoice.id,
    createdAt: now,
    updatedAt: now,
  };
  await db.invoices.add(record);
  return record;
}

/** Cuándo un error es transitorio (se reintenta solo) y cuándo hay que corregir algo. */
const isTransient = (e: ApiError) => e.status === 0 || e.status >= 500 || e.status === 409;

async function send(record: InvoiceRecord, token: string): Promise<void> {
  try {
    const result = await (record.kind === "factura"
      ? api<IssuedInvoice>("/api/arca/invoices", { method: "POST", body: JSON.stringify({ id: record.id, saleId: record.saleId, ...record.request }) }, token)
      : api<IssuedInvoice>(`/api/arca/invoices/${record.associatedId}/credit-note`, { method: "POST", body: JSON.stringify({ id: record.id }) }, token));
    await db.invoices.update(record.id, {
      status: result.status,
      result,
      error: result.status === "rechazada" ? result.messages.join(" · ") || "ARCA rechazó el comprobante." : undefined,
      updatedAt: Date.now(),
    });
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, "error", String(e));
    await db.invoices.update(record.id, {
      status: isTransient(err) ? "pendiente" : "rechazada",
      error: err.message,
      updatedAt: Date.now(),
    });
  }
}

let processing: Promise<void> | null = null;

/** Manda a ARCA lo pendiente y pide las notas de crédito de ventas facturadas que se anularon. */
export function processInvoices(): Promise<void> {
  processing ??= (async () => {
    try {
      const cloud = await getCloudLink();
      if (!cloud || !navigator.onLine) return;
      // Facturas autorizadas de ventas anuladas → nota de crédito.
      const authorized = await db.invoices.where("status").equals("autorizada").filter((r) => r.kind === "factura").toArray();
      for (const inv of authorized) {
        const sale = await db.sales.get(inv.saleId);
        if (sale?.status === "anulada") await requestCreditNote(inv);
      }
      const pending = await db.invoices.where("status").equals("pendiente").sortBy("createdAt");
      for (const record of pending) {
        if (record.kind === "factura" && !record.error) {
          // Venta anulada antes de que la factura saliera: no se emite (si llegó a salir, el servidor la devuelve igual).
          const sale = await db.sales.get(record.saleId);
          if (sale?.status === "anulada" && !record.result) {
            await db.invoices.update(record.id, { status: "anulada", updatedAt: Date.now() });
            continue;
          }
        }
        if (record.kind === "nota_credito") {
          const original = await db.invoices.get(record.associatedId!);
          if (original?.status !== "autorizada") continue; // espera a que la factura se autorice
        }
        await send(record, cloud.token);
      }
    } finally {
      processing = null;
    }
  })();
  return processing;
}

/** La factura (y la nota de crédito, si hay) de una venta. */
export function useSaleInvoices(saleId: string | undefined): InvoiceRecord[] {
  return useLiveQuery(
    () => (saleId ? db.invoices.where("saleId").equals(saleId).sortBy("createdAt") : Promise.resolve([] as InvoiceRecord[])),
    [saleId],
    [],
  );
}

/** Espera (un rato) a que la factura de una venta quede autorizada o rechazada, para imprimirla. */
export async function waitForInvoice(id: string, timeoutMs = 12_000): Promise<InvoiceRecord | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await db.invoices.get(id);
    if (!r || r.status !== "pendiente" || Date.now() > end) return r;
    await new Promise((res) => setTimeout(res, 400));
  }
}
