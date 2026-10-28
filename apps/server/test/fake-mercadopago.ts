/**
 * Mercado Pago falso para tests: imita los endpoints de cobros presenciales (Orders API, cajas QR y Point)
 * y agrega /__fake/... para simular que el cliente paga, que lo rechazan o que el posnet toma el cobro.
 * Se puede correr solo: `PORT=3101 WEBHOOK_URL=http://127.0.0.1:3100/api/webhooks/mercadopago node test/fake-mercadopago.ts`
 */
import Fastify from "fastify";

export const FAKE_TOKEN = "APP_USR-prueba-token-valido";
export const FAKE_POS_ID = "CAJA1";
export const FAKE_TERMINAL_ID = "NEWLAND_N950__N950NCB801293324";

interface Order {
  id: string;
  type: "qr" | "point";
  status: string;
  status_detail: string;
  external_reference: string;
  total_amount: string;
  transactions: { payments: { id: string; amount: string; status: string }[] };
  type_response?: { qr_data: string };
}

export async function startFakeMercadoPago(options: { port?: number; webhookUrl?: string } = {}) {
  const app = Fastify();
  const orders = new Map<string, Order>();
  const byIdempotency = new Map<string, string>();
  const terminals = [{ id: FAKE_TERMINAL_ID, operating_mode: "STANDALONE", external_pos_id: FAKE_POS_ID, pos_id: 1, store_id: "1" }];
  let seq = 0;
  const requests: { method: string; url: string; body: unknown }[] = [];

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/__fake")) return;
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      return reply.status(401).send({ message: "invalid access token", error: "unauthorized", status: 401 });
    }
  });
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/__fake")) requests.push({ method: req.method, url: req.url, body: req.body });
  });

  app.get("/users/me", async () => ({ id: 123456789, nickname: "KIOSCO_PRUEBA", site_id: "MLA" }));
  const posList: { id: number; name: string; external_id: string; qr?: { image: string } }[] = [
    { id: 1, name: "Caja mostrador", external_id: FAKE_POS_ID, qr: { image: "https://example.invalid/qr.png" } },
    { id: 2, name: "Caja creada desde la app", external_id: "" },
  ];
  const stores: { id: number; external_id: string }[] = [];
  app.get("/pos", async () => ({ results: posList }));
  app.post<{ Params: { userId: string }; Body: Record<string, any> }>("/users/:userId/stores", async (req, reply) => {
    const loc = req.body.location ?? {};
    for (const f of ["street_name", "street_number", "city_name", "state_name", "latitude", "longitude"]) {
      if (loc[f] === undefined || loc[f] === "") return reply.status(400).send({ errors: [{ code: "invalid_location", message: `falta location.${f}` }] });
    }
    const existing = stores.find((st) => st.external_id === req.body.external_id);
    if (existing) return existing;
    const store = { id: 1000 + stores.length, external_id: req.body.external_id };
    stores.push(store);
    return reply.status(201).send(store);
  });
  app.post<{ Body: Record<string, any> }>("/v2/pos", async (req, reply) => {
    if (!req.headers["x-idempotency-key"]) return reply.status(400).send({ errors: [{ code: "empty_required_header" }] });
    if (!stores.some((st) => st.external_id === req.body.external_store_id)) return reply.status(404).send({ errors: [{ code: "store_not_found" }] });
    if (!/^[A-Za-z0-9]{1,40}$/.test(req.body.external_id)) return reply.status(400).send({ errors: [{ code: "invalid_external_id" }] });
    if (posList.some((p) => p.external_id === req.body.external_id)) return reply.status(409).send({ errors: [{ code: "pos_already_exists" }] });
    const pos = { id: 10 + posList.length, name: req.body.name, external_id: req.body.external_id, qr: { image: "https://example.invalid/nuevo.png" } };
    posList.push(pos);
    return reply.status(201).send({ ...pos, qr_response: pos.qr });
  });
  app.get("/terminals/v1/list", async () => ({ data: { terminals }, paging: { total: terminals.length, offset: 0, limit: 50 } }));
  app.patch<{ Body: { terminals: { id: string; operating_mode: string }[] } }>("/terminals/v1/setup", async (req) => {
    for (const t of req.body.terminals) {
      const found = terminals.find((x) => x.id === t.id);
      if (found) found.operating_mode = t.operating_mode;
    }
    return { terminals: req.body.terminals };
  });

  app.post<{ Body: Record<string, any> }>("/v1/orders", async (req, reply) => {
    const key = req.headers["x-idempotency-key"] as string | undefined;
    if (!key) return reply.status(400).send({ errors: [{ code: "empty_required_header" }] });
    const existing = byIdempotency.get(key);
    if (existing) return orders.get(existing);
    const b = req.body;
    const amount = b.transactions?.payments?.[0]?.amount;
    if (typeof amount !== "string" || !/^\d+(\.\d{1,2})?$/.test(amount)) return reply.status(400).send({ errors: [{ code: "invalid_amount" }] });
    if (b.type === "qr") {
      if (b.total_amount !== amount) return reply.status(400).send({ errors: [{ code: "invalid_total_amount" }] });
      if (!posList.some((p) => p.external_id && p.external_id === b.config?.qr?.external_pos_id)) return reply.status(404).send({ errors: [{ code: "pos_not_found" }] });
    } else if (b.type === "point") {
      const terminal = terminals.find((t) => t.id === b.config?.point?.terminal_id);
      if (!terminal || terminal.operating_mode !== "PDV") return reply.status(404).send({ errors: [{ code: "terminal_not_found" }] });
      const busy = [...orders.values()].some((o) => o.type === "point" && ["created", "at_terminal"].includes(o.status));
      if (busy) return reply.status(409).send({ errors: [{ code: "already_queued_order_for_terminal" }] });
    } else {
      return reply.status(400).send({ errors: [{ code: "invalid_type" }] });
    }
    seq++;
    const order: Order = {
      id: `ORD01FAKE${String(seq).padStart(6, "0")}`,
      type: b.type,
      status: "created",
      status_detail: "created",
      external_reference: b.external_reference,
      total_amount: amount,
      transactions: { payments: [{ id: `PAY01FAKE${String(seq).padStart(6, "0")}`, amount, status: "created" }] },
      ...(b.type === "qr" ? { type_response: { qr_data: `00020101021243650016COM.MERCADOLIBRE0201306361FAKE${seq}5204970053030325802AR6304ABCD` } } : {}),
    };
    orders.set(order.id, order);
    byIdempotency.set(key, order.id);
    return reply.status(201).send(order);
  });

  app.get<{ Params: { id: string } }>("/v1/orders/:id", async (req, reply) => {
    const order = orders.get(req.params.id);
    return order ?? reply.status(404).send({ errors: [{ code: "order_not_found" }] });
  });

  app.post<{ Params: { id: string } }>("/v1/orders/:id/cancel", async (req, reply) => {
    const order = orders.get(req.params.id);
    if (!order) return reply.status(404).send({ errors: [{ code: "order_not_found" }] });
    if (order.status === "at_terminal") return reply.status(409).send({ errors: [{ code: "cannot_cancel_order_at_terminal" }] });
    if (order.status !== "created") return reply.status(409).send({ errors: [{ code: "order_already_finalized" }] });
    setStatus(order, "canceled", "canceled");
    return order;
  });

  // --- Control de los tests ---

  function setStatus(order: Order, status: string, detail: string) {
    order.status = status;
    order.status_detail = detail;
    for (const p of order.transactions.payments) p.status = status;
    if (options.webhookUrl) {
      void fetch(options.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-request-id": `req-${order.id}` },
        body: JSON.stringify({ action: `order.${status}`, type: "order", data: { id: order.id }, user_id: 123456789, live_mode: false }),
      }).catch(() => {});
    }
  }

  const byRef = (ref: string) => [...orders.values()].find((o) => o.external_reference === ref);

  app.post<{ Params: { ref: string; action: string } }>("/__fake/orders/:ref/:action", async (req, reply) => {
    const order = req.params.ref === "latest" ? [...orders.values()].at(-1) : byRef(req.params.ref);
    if (!order) return reply.status(404).send({ error: "no order" });
    if (req.params.action === "pay") setStatus(order, "processed", "accredited");
    else if (req.params.action === "reject") setStatus(order, "failed", "rejected");
    else if (req.params.action === "at-terminal") setStatus(order, "at_terminal", "at_terminal");
    else return reply.status(400).send({ error: "acción desconocida" });
    return order;
  });
  app.get("/__fake/orders", async () => [...orders.values()]);
  app.get("/__fake/requests", async () => requests);

  const address = await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
  return {
    url: address,
    orders,
    requests,
    pay: (ref: string) => setStatus(byRef(ref)!, "processed", "accredited"),
    setStatus: (ref: string, status: string, detail = status) => setStatus(byRef(ref)!, status, detail),
    close: () => app.close(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeMercadoPago({ port: Number(process.env.PORT ?? 3101), webhookUrl: process.env.WEBHOOK_URL });
  console.log(`Mercado Pago falso en ${fake.url}`);
}
