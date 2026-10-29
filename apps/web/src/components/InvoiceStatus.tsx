import { CheckCircle2 } from "lucide-react";
import { CBTE_LABELS, formatInvoiceNumber } from "@misventas/core";
import type { InvoiceRecord } from "../db";

/** Estado de la factura de una venta, en una línea. */
export function InvoiceStatus({ record }: { record: InvoiceRecord }) {
  if (record.status === "autorizada" && record.result) {
    return (
      <p className="flex items-center gap-2 font-semibold text-brand">
        <CheckCircle2 className="size-5" /> {CBTE_LABELS[record.result.cbteTipo]} {formatInvoiceNumber(record.result.ptoVta, record.result.numero ?? 0)}
        {record.result.ambiente === "homologacion" && <span className="text-sm font-normal text-muted">(prueba)</span>}
      </p>
    );
  }
  if (record.status === "pendiente") {
    return <p className="font-semibold text-warn">{record.kind === "factura" ? "Factura" : "Nota de crédito"} pendiente: se emite sola cuando haya conexión con ARCA.{record.error ? ` (${record.error})` : ""}</p>;
  }
  if (record.status === "anulada") return <p className="text-muted">La factura no se emitió porque la venta se anuló antes.</p>;
  return <p className="font-semibold text-danger">ARCA rechazó la {record.kind === "factura" ? "factura" : "nota de crédito"}: {record.error}</p>;
}
