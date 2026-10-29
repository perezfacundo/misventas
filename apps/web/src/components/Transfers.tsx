import { useEffect, useMemo, useState } from "react";
import { PackageCheck, Search, Send, Trash2 } from "lucide-react";
import { findByCode, searchProducts } from "@misventas/core";
import { currentBranchId, type Product, type Transfer } from "../db";
import { branchName, cancelTransfer, receiveTransfer, sendTransfer, useBranches, useIncomingTransfers, useOutgoingTransfers } from "../data/branches";
import { formatDateTime, plural } from "../lib/format";
import { Button, cx, EmptyState, Field, inputClass, Modal, TextInput, useToast } from "./ui";
import { useSession } from "./Session";

/** Envíos que llegan a esta sucursal y los que salieron y todavía no se recibieron. */
export function TransferBanners() {
  const incoming = useIncomingTransfers();
  const outgoing = useOutgoingTransfers();
  const branches = useBranches();
  const [receiving, setReceiving] = useState<Transfer | null>(null);
  const toast = useToast();
  if (!incoming.length && !outgoing.length) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      {incoming.map((t) => (
        <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand/40 bg-brand-soft px-4 py-3">
          <span className="text-lg"><b>Llegó un envío</b> de {branchName(branches, t.fromBranchId)}: {plural(t.items.reduce((s, i) => s + i.quantity, 0), "unidad", "unidades")} de {plural(t.items.length, "producto", "productos")}</span>
          <Button variant="primary" onClick={() => setReceiving(t)}><PackageCheck className="size-5" /> Recibir</Button>
        </div>
      ))}
      {outgoing.map((t) => (
        <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface-2 px-4 py-3">
          <span>Enviado a <b>{branchName(branches, t.toBranchId)}</b> el {formatDateTime(t.createdAt)}: todavía no lo recibieron.</span>
          <Button variant="ghost" onClick={async () => {
            try {
              await cancelTransfer(t);
              toast({ tone: "ok", message: "Envío cancelado: la mercadería volvió al stock." });
            } catch (e) {
              toast({ tone: "error", message: e instanceof Error ? e.message : String(e) });
            }
          }}>Cancelar envío</Button>
        </div>
      ))}
      <ReceiveDialog transfer={receiving} onClose={() => setReceiving(null)} />
    </div>
  );
}

function ReceiveDialog({ transfer, onClose }: { transfer: Transfer | null; onClose: () => void }) {
  const [received, setReceived] = useState<Record<string, string>>({});
  const toast = useToast();
  const { user } = useSession();
  useEffect(() => {
    if (transfer) setReceived(Object.fromEntries(transfer.items.map((i) => [i.productId, String(i.quantity)])));
  }, [transfer]);
  if (!transfer) return null;
  const missing = transfer.items.some((i) => Number(received[i.productId] ?? i.quantity) < i.quantity);
  return (
    <Modal open onClose={onClose} title="Recibir envío" footer={
      <>
        <Button onClick={onClose}>Después</Button>
        <Button variant="primary" onClick={async () => {
          try {
            await receiveTransfer(transfer, Object.fromEntries(Object.entries(received).map(([k, v]) => [k, Number(v) || 0])), user.name);
            toast({ tone: "ok", message: "Envío recibido: ya está en el stock." });
            onClose();
          } catch (e) {
            toast({ tone: "error", message: e instanceof Error ? e.message : String(e) });
          }
        }}>Confirmar recepción</Button>
      </>
    }>
      <div className="flex flex-col gap-3">
        <p className="text-muted">Contá lo que llegó. Si falta algo, cargá la cantidad real: entra al stock solo lo recibido.</p>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {transfer.items.map((i) => (
            <li key={i.productId} className="flex items-center gap-3 px-4 py-2">
              <span className="flex-1"><b>{i.name}</b> <span className="text-muted">· enviaron {i.quantity}</span></span>
              <TextInput inputMode="numeric" aria-label={`Recibido de ${i.name}`} className="w-20! text-center" value={received[i.productId] ?? ""}
                onChange={(e) => setReceived({ ...received, [i.productId]: e.target.value.replace(/\D/g, "") })} />
            </li>
          ))}
        </ul>
        {missing && <p className="font-semibold text-warn">Llegó menos de lo enviado: la diferencia queda registrada en el envío.</p>}
      </div>
    </Modal>
  );
}

/** Enviar mercadería a otra sucursal. */
export function TransferDialog({ open, products, onClose }: { open: boolean; products: Product[]; onClose: () => void }) {
  const branches = useBranches();
  const others = branches.filter((b) => b.id !== currentBranchId());
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<{ product: Product; quantity: string }[]>([]);
  const [query, setQuery] = useState("");
  const toast = useToast();
  const { user } = useSession();
  const results = useMemo(() => searchProducts(products, query, 6), [products, query]);
  useEffect(() => {
    if (open) { setTo(others[0]?.id ?? ""); setLines([]); setQuery(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const add = (p: Product) => {
    setLines((ls) => (ls.some((l) => l.product.id === p.id) ? ls.map((l) => (l.product.id === p.id ? { ...l, quantity: String(Number(l.quantity) + 1) } : l)) : [{ product: p, quantity: "1" }, ...ls]));
    setQuery("");
  };
  const valid = lines.filter((l) => Number(l.quantity) > 0);
  const overStock = valid.filter((l) => l.product.trackStock && Number(l.quantity) > l.product.stock);

  return (
    <Modal open={open} onClose={onClose} title="Enviar a otra sucursal" wide footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={!to || !valid.length} onClick={async () => {
          try {
            await sendTransfer({ toBranchId: to, userName: user.name, items: valid.map((l) => ({ productId: l.product.id, name: l.product.name, quantity: Math.round(Number(l.quantity)) })) });
            toast({ tone: "ok", message: `Enviaste ${plural(valid.length, "producto", "productos")} a ${branchName(branches, to)}` });
            onClose();
          } catch (e) {
            toast({ tone: "error", message: e instanceof Error ? e.message : String(e) });
          }
        }}><Send className="size-5" /> Enviar</Button>
      </>
    }>
      <div className="flex flex-col gap-4">
        <Field label="¿A qué sucursal?">
          <select className={inputClass} value={to} onChange={(e) => setTo(e.target.value)}>
            {others.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Escaneá o buscá qué mandás"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const p = findByCode(products, query) ?? results[0]; if (p) add(p); } }}
            aria-label="Buscar producto para enviar" className={cx(inputClass, "pl-11")} />
          {query && results.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              {results.map((p) => (
                <li key={p.id}><button type="button" onClick={() => add(p)} className="w-full px-4 py-2.5 text-left text-lg hover:bg-brand-soft">{p.name} <span className="text-muted">· hay {p.stock}</span></button></li>
              ))}
            </ul>
          )}
        </div>
        {lines.length === 0 ? (
          <EmptyState icon={<Send />} title="Todavía no agregaste nada">Lo que mandes sale del stock de esta sucursal y entra en la otra cuando lo reciban.</EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {lines.map((l, i) => (
              <li key={l.product.id} className="flex items-center gap-3 px-4 py-2">
                <span className="flex-1"><b>{l.product.name}</b> <span className="text-muted">· hay {l.product.stock}</span></span>
                <TextInput inputMode="numeric" aria-label={`Cantidad a enviar de ${l.product.name}`} className="w-20! text-center" value={l.quantity}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value.replace(/\D/g, "") } : x)))} />
                <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Quitar"><Trash2 className="size-5" /></button>
              </li>
            ))}
          </ul>
        )}
        {overStock.length > 0 && <p className="font-semibold text-warn">Mandás más de lo que figura en stock de {overStock.map((l) => l.product.name).join(", ")}. Se puede, pero revisá el conteo.</p>}
      </div>
    </Modal>
  );
}
