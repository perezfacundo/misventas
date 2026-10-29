import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CheckCircle2, Minus, Pause, Percent, Play, Plus, Printer, ScanBarcode, Search, Trash2 } from "lucide-react";
import {
  addMisc, addProduct, cartSubtotal, cartTotal, emptyCart, findByCode, formatMoney, itemCount,
  lineTotal, PAYMENT_LABELS, removeLine, searchProducts, setDiscount, setQuantity,
  uuidv7, type Cart, type Cents, type Payment,
} from "@misventas/core";
import { db, type InvoiceReceiver, type IssuedInvoice, type Product, type Sale, type Settings } from "../db";
import { useProducts } from "../data/products";
import { useOpenSession } from "../data/cash";
import { completeSale } from "../data/sales";
import { isTypingTarget, useHotkeys, usePersistentCart } from "../lib/hooks";
import { formatTime, plural } from "../lib/format";
import { Button, cx, EmptyState, Field, Kbd, MoneyInput, Modal, StockBadge, TextInput, useToast } from "../components/ui";
import { CobroDialog } from "../components/CobroDialog";
import { OpenCashDialog } from "../components/OpenCashDialog";
import { openCashDrawer, printTicket } from "../components/Ticket";
import { useSession } from "../components/Session";
import { InvoiceStatus } from "../components/InvoiceStatus";
import { forgetCharge, getCharge, rememberedCharge, type Charge } from "../payments/mercadopago";
import { processInvoices, requestInvoice, useSaleInvoices, waitForInvoice } from "../data/invoices";
import { getCloudLink } from "../sync/engine";


/** "3*" antes de escanear o buscar multiplica la cantidad, como en las cajas de supermercado. */
function parseQuery(q: string): { qty: number; text: string } {
  const m = /^(\d{1,3})\s*\*\s*(.*)$/.exec(q);
  return m ? { qty: Number(m[1]), text: m[2]! } : { qty: 1, text: q };
}

export function Vender({ settings }: { settings: Settings }) {
  const products = useProducts();
  const session = useOpenSession();
  const heldCarts = useLiveQuery(() => db.heldCarts.orderBy("createdAt").toArray(), [], []);
  const [cart, setCart] = usePersistentCart();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [dialog, setDialog] = useState<null | "cobro" | "abrir-caja" | "varios" | "descuento">(null);
  const [resume, setResume] = useState<Charge | null>(null);
  const cloud = useLiveQuery(getCloudLink, []);
  // Facturación activa: con ARCA configurado en Ajustes y este dispositivo vinculado a la nube.
  const invoicing =
    cloud && settings.fiscalCondition && settings.invoiceMode && settings.invoiceMode !== "nunca"
      ? { mode: settings.invoiceMode, condition: settings.fiscalCondition }
      : null;
  const searchRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { user, can } = useSession();

  const { qty, text } = parseQuery(query);
  const results = useMemo(() => searchProducts(products, text, 8), [products, text]);
  const favorites = useMemo(() => products.filter((p) => p.favorite).slice(0, 15), [products]);
  const total = cartTotal(cart);

  useEffect(() => setSelected(0), [text]);

  const focusSearch = () => searchRef.current?.focus();

  const add = (p: Product, quantity = 1) => {
    const inCart = cart.lines.find((l) => l.productId === p.id)?.quantity ?? 0;
    const next = addProduct(cart, { id: p.id, name: p.name, price: p.price, cost: p.cost, ivaRate: p.ivaRate }, quantity);
    setCart(next);
    setHighlight(next.lines.find((l) => l.productId === p.id)?.lineId ?? null);
    setLastSale(null);
    setQuery("");
    if (p.trackStock && p.stock - inCart - quantity < 0) {
      toast({ tone: "ok", message: `Según el sistema no queda stock de ${p.name}. Se vende igual; después revisá el stock.` });
    }
  };

  const submitSearch = () => {
    if (!text.trim()) return;
    const exact = findByCode(products, text);
    const product = exact ?? results[selected];
    if (product) add(product, qty);
    else toast({ tone: "error", message: `No encontramos "${text.trim()}". Podés cobrarlo como "Varios" o cargarlo en Productos.` });
  };

  const undoable = (message: string, previous: Cart) =>
    toast({ tone: "ok", message, action: { label: "Deshacer", run: () => setCart(previous) } });

  const startCobro = () => {
    if (!cart.lines.length) return;
    setDialog(session ? "cobro" : "abrir-caja");
  };

  const printError = (e: unknown) => toast({ tone: "error", message: `No se pudo imprimir: ${e instanceof Error ? e.message : String(e)}` });

  const finishSale = async (payments: Payment[], change: Cents, customerId?: string, invoiceReceiver?: InvoiceReceiver | null) => {
    try {
      const sale = await completeSale(cart, payments, change, { user, customerId });
      forgetCharge();
      setResume(null);
      setCart(emptyCart());
      setLastSale(sale);
      setDialog(null);
      const paidCash = payments.some((p) => p.method === "efectivo");
      if (invoiceReceiver) {
        // La factura se pide siempre (aunque no haya internet); se imprime cuando ARCA la autoriza.
        const record = await requestInvoice(sale, invoiceReceiver);
        void processInvoices();
        if (paidCash && !settings.autoPrint) openCashDrawer(settings).catch(printError);
        if (settings.autoPrint) {
          void waitForInvoice(record.id).then((r) => {
            if (r?.status !== "autorizada") {
              toast({ tone: "ok", message: "La factura todavía no salió: se imprime el ticket interno. Reimprimila desde Ventas." });
            }
            return printTicket(sale, settings, { openDrawer: paidCash, invoice: r?.result }).catch(printError);
          });
        }
      } else {
        const print = settings.autoPrint ? printTicket(sale, settings, { openDrawer: paidCash }) : paidCash ? openCashDrawer(settings) : null;
        print?.catch(printError);
      }
      focusSearch();
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : "No se pudo guardar la venta." });
    }
  };

  const holdCart = async () => {
    if (!cart.lines.length) return;
    await db.heldCarts.add({ id: uuidv7(), cart, createdAt: Date.now() });
    setCart(emptyCart());
    toast({ tone: "ok", message: "Venta en espera. La retomás cuando quieras." });
  };

  const resumeCart = async (id: string) => {
    const held = await db.heldCarts.get(id);
    if (!held) return;
    await db.transaction("rw", db.heldCarts, async () => {
      await db.heldCarts.delete(id);
      // Si había algo en curso, queda en espera en su lugar.
      if (cart.lines.length) await db.heldCarts.add({ id: uuidv7(), cart, createdAt: Date.now() });
    });
    setCart(held.cart);
    setLastSale(null);
  };

  const noDialog = dialog === null;
  useHotkeys(
    {
      F2: (e) => { e.preventDefault(); focusSearch(); },
      F4: (e) => { e.preventDefault(); setDialog("varios"); },
      F8: (e) => { e.preventDefault(); void holdCart(); },
      F12: (e) => { e.preventDefault(); startCobro(); },
    },
    noDialog,
  );

  // El lector de códigos "tipea": si el foco no está en un campo, lo redirigimos al buscador.
  useEffect(() => {
    if (!noDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      e.preventDefault();
      setQuery((q) => q + e.key);
      focusSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [noDialog]);

  // Si la app se cerró mientras el cliente pagaba con Mercado Pago, se retoma ese cobro.
  useEffect(() => {
    const pending = rememberedCharge();
    if (!pending) return;
    if (!cart.lines.length) return forgetCharge();
    void getCharge(pending.id)
      .then((charge) => {
        if (charge.status === "fallido") return forgetCharge();
        setResume(charge);
        setDialog("cobro");
        toast({ tone: "ok", message: charge.status === "pagado" ? "Se recuperó un pago de Mercado Pago que quedó sin registrar." : "Hay un cobro de Mercado Pago en curso." });
      })
      .catch(() => {
        // Sin conexión: se vuelve a intentar la próxima vez que se abra la pantalla.
      });
    // Solo al entrar a la pantalla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!highlight) return;
    const id = setTimeout(() => setHighlight(null), 1200);
    return () => clearTimeout(id);
  }, [highlight]);

  return (
    <div className="flex h-full flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_25rem]">
      {/* Columna izquierda: buscar, favoritos y carrito */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:p-6">
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); submitSearch(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Escape") setQuery("");
            }}
            placeholder="Escaneá o escribí el producto"
            aria-label="Buscar producto o escanear código"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="search-results"
            autoComplete="off"
            className="min-h-16 w-full rounded-2xl border-2 border-line bg-surface pl-14 pr-24 text-xl shadow-sm focus:border-brand focus:outline-none focus-visible:outline-none"
          />
          <span className="pointer-events-none absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-2 text-muted">
            {qty > 1 && <span className="rounded-lg bg-brand-soft px-2 py-0.5 font-bold text-ink">×{qty}</span>}
            <Kbd>F2</Kbd>
          </span>

          {results.length > 0 && (
            <ul id="search-results" role="listbox" className="absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
              {results.map((p, i) => (
                <li key={p.id} role="option" aria-selected={i === selected}>
                  <button
                    type="button"
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => add(p, qty)}
                    className={cx("flex w-full items-center gap-4 px-4 py-3 text-left", i === selected && "bg-brand-soft")}
                  >
                    <span className="flex-1 text-lg font-semibold">{p.name}</span>
                    <StockBadge stock={p.stock} minStock={p.minStock} trackStock={p.trackStock} />
                    <span className="num w-28 text-right text-xl font-bold">{formatMoney(p.price)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Favoritos: los productos sin código o los que más salen */}
        <div className="flex gap-2 overflow-x-auto pb-1 lg:grid lg:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] lg:overflow-visible">
          {favorites.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => add(p)}
              className="flex min-h-18 w-36 shrink-0 flex-col justify-between rounded-2xl border border-line bg-surface px-3 py-2.5 text-left shadow-sm hover:border-brand active:scale-[0.98] lg:w-auto"
            >
              <span className="line-clamp-2 text-base font-semibold leading-tight">{p.name}</span>
              <span className="num text-lg font-bold text-muted">{formatMoney(p.price)}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDialog("varios")}
            className="flex min-h-18 w-36 shrink-0 flex-col items-start justify-between rounded-2xl border-2 border-dashed border-line px-3 py-2.5 text-left hover:border-brand lg:w-auto"
          >
            <span className="flex items-center gap-1.5 text-base font-semibold"><Plus className="size-5" /> Varios</span>
            <span className="text-sm text-muted">Precio libre <Kbd>F4</Kbd></span>
          </button>
        </div>

        {/* Carrito */}
        <section aria-label="Productos de esta venta" className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line bg-surface">
          {cart.lines.length === 0 ? (
            <EmptyState icon={<ScanBarcode />} title="Listo para vender">
              Escaneá un producto, buscalo por nombre o tocá un favorito.
              <span className="mt-2 block text-sm">Tip: escribí <b>3*</b> antes de escanear para sumar 3 unidades.</span>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {cart.lines.map((l) => (
                <li key={l.lineId} className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors duration-700", highlight === l.lineId && "bg-brand-soft")}>
                  {/* En pantallas angostas el nombre va arriba y los controles abajo, alineados a la derecha. */}
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="truncate text-lg font-semibold">{l.name}</p>
                    <p className="num text-muted">{formatMoney(l.unitPrice)} c/u</p>
                  </div>
                  <div className="ml-auto flex items-center gap-3">
                    <div className="flex items-center gap-1" role="group" aria-label={`Cantidad de ${l.name}`}>
                      <button type="button" onClick={() => setCart(setQuantity(cart, l.lineId, l.quantity - 1))} className="grid size-12 place-items-center rounded-xl border border-line hover:bg-surface-2" aria-label="Restar uno">
                        <Minus className="size-5" />
                      </button>
                      <span className="num w-10 text-center text-xl font-bold" aria-live="polite">{l.quantity}</span>
                      <button type="button" onClick={() => setCart(setQuantity(cart, l.lineId, l.quantity + 1))} className="grid size-12 place-items-center rounded-xl border border-line hover:bg-surface-2" aria-label="Sumar uno">
                        <Plus className="size-5" />
                      </button>
                    </div>
                    <span className="num w-28 text-right text-xl font-bold">{formatMoney(lineTotal(l))}</span>
                    <button
                      type="button"
                      onClick={() => { undoable(`Quitaste ${l.name}`, cart); setCart(removeLine(cart, l.lineId)); }}
                      className="grid size-12 place-items-center rounded-xl text-muted hover:bg-danger-soft hover:text-danger"
                      aria-label={`Quitar ${l.name}`}
                    >
                      <Trash2 className="size-5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Columna derecha (abajo en celular): el total manda */}
      <aside className="border-t border-line bg-surface p-4 lg:flex lg:flex-col lg:border-l lg:border-t-0 lg:p-6">
        {cart.lines.length > 0 ? (
          <>
            <div className="flex items-end justify-between gap-4 lg:flex-col lg:items-start">
              <div>
                <p className="text-lg font-semibold uppercase tracking-wide text-muted">Total</p>
                <p className="num text-5xl font-extrabold leading-none lg:text-7xl">{formatMoney(total)}</p>
              </div>
              <p className="text-lg text-muted lg:mt-2">{plural(itemCount(cart), "producto", "productos")}</p>
            </div>
            {cart.discount > 0 && (
              <p className="num mt-2 text-lg text-muted">
                Subtotal {formatMoney(cartSubtotal(cart))} · Descuento <b className="text-ink">−{formatMoney(cart.discount)}</b>
              </p>
            )}
            <div className="mt-4 hidden flex-wrap gap-2 sm:flex lg:mt-6">
              {can("descontar") && <Button onClick={() => setDialog("descuento")}><Percent className="size-5" /> Descuento</Button>}
              <Button onClick={holdCart}><Pause className="size-5" /> En espera <Kbd>F8</Kbd></Button>
              <Button variant="ghost" onClick={() => { undoable("Vaciaste la venta", cart); setCart(emptyCart()); }}>
                <Trash2 className="size-5" /> Vaciar
              </Button>
            </div>
            <Button variant="primary" size="xl" onClick={startCobro} className="mt-4 w-full lg:mt-auto">
              Cobrar <Kbd>F12</Kbd>
            </Button>
          </>
        ) : lastSale ? (
          <LastSalePanel sale={lastSale} onPrint={(invoice) => printTicket(lastSale, settings, { invoice }).catch(printError)} />
        ) : (
          <p className="hidden text-lg text-muted lg:block">El total aparece acá apenas agregás un producto.</p>
        )}

        {heldCarts.length > 0 && (
          <div className="mt-4 lg:mt-6">
            <p className="mb-2 text-sm font-semibold text-muted">En espera</p>
            <div className="flex flex-wrap gap-2">
              {heldCarts.map((h) => (
                <Button key={h.id} onClick={() => resumeCart(h.id)} className="num">
                  <Play className="size-4" /> {formatMoney(cartTotal(h.cart))} · {formatTime(h.createdAt)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </aside>

      <CobroDialog
        open={dialog === "cobro"}
        total={total}
        methods={settings.enabledMethods}
        resume={resume}
        invoicing={invoicing}
        onClose={() => { setDialog(null); setResume(null); focusSearch(); }}
        onConfirm={finishSale}
      />
      <OpenCashDialog open={dialog === "abrir-caja"} onClose={() => setDialog(null)} onOpened={() => setDialog("cobro")} />
      <MiscDialog
        open={dialog === "varios"}
        onClose={() => { setDialog(null); focusSearch(); }}
        onAdd={(price, name) => { setCart(addMisc(cart, price, name || "Varios")); setLastSale(null); setDialog(null); focusSearch(); }}
      />
      <DiscountDialog
        open={dialog === "descuento"}
        cart={cart}
        onClose={() => setDialog(null)}
        onApply={(d) => { setCart(setDiscount(cart, d)); setDialog(null); }}
      />
    </div>
  );
}

function LastSalePanel({ sale, onPrint }: { sale: Sale; onPrint: (invoice?: IssuedInvoice) => void }) {
  const invoice = useSaleInvoices(sale.id).find((r) => r.kind === "factura");
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <p className="flex items-center gap-2 text-xl font-bold text-brand">
        <CheckCircle2 className="size-7" /> Venta registrada
      </p>
      {sale.change > 0 ? (
        <div className="rounded-2xl bg-brand-soft p-4">
          <p className="text-lg font-semibold uppercase tracking-wide">Vuelto</p>
          <p className="num text-6xl font-extrabold leading-none text-brand">{formatMoney(sale.change)}</p>
        </div>
      ) : null}
      <p className="num text-lg text-muted">
        Total {formatMoney(sale.total)} · {sale.payments.map((p) => PAYMENT_LABELS[p.method]).join(" + ")}
      </p>
      {invoice && <InvoiceStatus record={invoice} />}
      <Button onClick={() => onPrint(invoice?.result)} className="self-start">
        <Printer className="size-5" /> {invoice?.status === "autorizada" ? "Imprimir factura" : "Imprimir ticket"}
      </Button>
    </div>
  );
}

function MiscDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (price: Cents, name: string) => void }) {
  const [price, setPrice] = useState<Cents | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) { setPrice(null); setName(""); }
  }, [open]);
  const submit = () => price && price > 0 && onAdd(price, name.trim());
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cobrar algo que no está cargado"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={!price}>Agregar</Button></>}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Precio">
          <MoneyInput value={price} onChange={setPrice} placeholder="0" className="min-h-16 text-3xl font-bold" />
        </Field>
        <Field label="¿Qué es? (opcional)" hint="Te sirve para cargarlo después en Productos.">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Varios" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function DiscountDialog({ open, cart, onClose, onApply }: { open: boolean; cart: Cart; onClose: () => void; onApply: (d: Cents) => void }) {
  const [mode, setMode] = useState<"monto" | "porcentaje">("porcentaje");
  const [text, setText] = useState("");
  const [amount, setAmount] = useState<Cents | null>(null);
  const subtotal = cartSubtotal(cart);
  useEffect(() => {
    if (open) { setText(""); setAmount(cart.discount || null); }
  }, [open, cart.discount]);
  const percent = Number(text.replace(",", "."));
  const discount = mode === "monto" ? amount ?? 0 : Number.isFinite(percent) ? Math.round((subtotal * percent) / 100) : 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Descuento"
      footer={
        <>
          {cart.discount > 0 && <Button variant="ghost" onClick={() => onApply(0)}>Quitar descuento</Button>}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={() => onApply(discount)} disabled={discount <= 0}>Aplicar</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Button variant={mode === "porcentaje" ? "primary" : "secondary"} onClick={() => setMode("porcentaje")}>Porcentaje</Button>
          <Button variant={mode === "monto" ? "primary" : "secondary"} onClick={() => setMode("monto")}>Monto fijo</Button>
        </div>
        {mode === "porcentaje" ? (
          <Field label="Porcentaje de descuento">
            <TextInput inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="10" autoFocus />
          </Field>
        ) : (
          <Field label="Monto a descontar">
            <MoneyInput value={amount} onChange={setAmount} placeholder="0" autoFocus />
          </Field>
        )}
        <p className="num text-lg">
          Subtotal {formatMoney(subtotal)} → <b>{formatMoney(Math.max(0, subtotal - Math.min(discount, subtotal)))}</b>
        </p>
      </div>
    </Modal>
  );
}
