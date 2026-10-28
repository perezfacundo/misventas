# Mis Ventas

Sistema para kioscos: vender, cobrar y controlar el stock, con o sin internet, en uno o varios dispositivos.
Corre en el navegador (PC, tablet o celular) y se instala como app (PWA) para usarla offline en el escritorio.

## Estado

**Fase 1 (MVP offline):**
- **Venta:** lector de código de barras, favoritos, "Varios" y ventas en espera.
- **Cobro:** efectivo con vuelto, medios manuales y pago con dos medios.
- **Caja:** apertura, ingresos y retiros, y arqueo al cerrar.
- **Stock:** por movimientos, con ingreso de mercadería y aumento masivo de precios.
- **Hoy:** resumen del día.
- **Ventas:** historial, reimpresión y anulación.
- **Ajustes:** tamaño de texto, tema y copia de seguridad.

**Fase 2 (multi-dispositivo):**
- **Cuenta en la nube** y vinculación de dispositivos. Cada caja tiene su prefijo de comprobante (D01, D02...).
- **Sincronización offline-first** con aviso en tiempo real. Ver más abajo.
- **Usuarios con PIN** y roles: Dueño/a, Encargado/a y Cajero/a.
- **Fiado (cuenta corriente):** límite de crédito, pagos parciales y recordatorio por WhatsApp.
- **Proveedores:** días de visita, pedido armado con lo que falta (WhatsApp o copiar) y entregas que se pueden pagar con la caja.
- **Reportes:** por período, por día, producto, categoría, cajero y medio de pago, productos sin movimiento y exportación CSV.

**Fase 3 (cobros integrados y escritorio):**
- **Mercado Pago QR y Point:**
  - Se cobra desde la caja: el QR aparece en pantalla o el cobro se manda al posnet.
  - La venta se registra sola cuando entra el pago.
  - Si la app se cierra mientras el cliente paga, el cobro se retoma.
  - Desde Ajustes se conecta la cuenta, se crea la caja QR y se activa el modo integrado del posnet.
- **App de escritorio (Tauri):** la misma app, sin navegador. Imprime directo en la ticketera en ESC/POS (USB, del sistema o de red) y abre el cajón de dinero.
- **Listo para producción con Docker:** PostgreSQL + Mis Ventas + Caddy con HTTPS automático.

Lo que sigue (Fase 4: factura electrónica ARCA opcional; Fase 5: extras) está en el documento de planificación.

## Estructura

```
packages/core   Dominio puro y testeado: dinero, carrito, cobro, stock, precios, caja, fiado, permisos, reportes, tipos de sync
apps/web        App React + Vite + Tailwind, PWA, base local IndexedDB (Dexie), sincronización, tickets ESC/POS
apps/server     API Fastify + Drizzle sobre PostgreSQL (o PGlite embebido si no hay DATABASE_URL), Mercado Pago
apps/desktop    App de escritorio Tauri 2: empaqueta apps/web e imprime directo en la ticketera
```

## Comandos

```bash
npm install
npm run server     # API en http://127.0.0.1:3000 (PGlite en apps/server/data/, sin instalar nada)
npm run dev        # app en http://localhost:5173 (le pasa /api al servidor)
npm test           # tests unitarios: core, server (con Mercado Pago falso) y web
npm run e2e        # punta a punta en escritorio y celular (levanta servidor y app solos)
npm run typecheck
```

Para probar contra PostgreSQL real: `TEST_DATABASE_URL=postgres://… npm test -w @misventas/server`.

## Puesta en producción

Necesitás un servidor con Docker (un VPS de los más chicos alcanza), un dominio apuntando a su IP y los puertos 80 y 443 abiertos.

```bash
cp .env.example .env      # completá DOMAIN, POSTGRES_PASSWORD y APP_SECRET (openssl rand -base64 32)
docker compose --profile https up -d --build
```

Eso levanta PostgreSQL, Mis Ventas (app + API en un solo proceso) y Caddy, que saca el certificado HTTPS solo. La app queda en `https://TU-DOMINIO`: desde ahí se instala en cada celular o PC, y en Ajustes se crea la cuenta.

**Copias de seguridad de la base:**

```bash
docker compose exec db pg_dump -U misventas misventas | gzip > backup-$(date +%F).sql.gz
```

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | PostgreSQL. Sin ella se usa PGlite en `DATA_DIR`. |
| `APP_SECRET` | Cifra los tokens de Mercado Pago. Obligatoria en producción para usar MP. No la cambies después. |
| `PUBLIC_URL` | URL pública (`https://…`), para mostrar la dirección del webhook de Mercado Pago. |
| `PORT`, `HOST` | Por defecto `3000` y `127.0.0.1`. En Docker, `0.0.0.0`. |
| `CORS_ORIGINS` | Orígenes extra permitidos (separados por coma). La app de escritorio ya está incluida. |
| `DATA_DIR` | Carpeta de PGlite. |
| `WEB_DIST` | Build de la app web que se sirve. Por defecto `apps/web/dist`. |

## Mercado Pago

1. En Ajustes → Mercado Pago, pegá el **Access Token de producción**. Se obtiene en [Mercado Pago Developers](https://www.mercadopago.com.ar/developers/panel/app): creá una aplicación de pagos presenciales. Se valida y se guarda cifrado.
2. **QR:** elegí una caja o tocá "Crear caja QR". Pide la dirección del kiosco y la ubicación del dispositivo. Las cajas creadas desde la app de Mercado Pago no sirven para integrar: no tienen `external_id`.
3. **Point:** elegí el posnet y tocá "Activar modo integrado" (modo PDV).
4. **Webhook (opcional):** en tu aplicación de Mercado Pago, configurá `https://TU-DOMINIO/api/webhooks/mercadopago` con el evento *Order* y cargá la clave secreta en Ajustes. Sin webhook, la caja consulta el estado cada 2,5 s.

**Seguridad:** el servidor nunca confía en el contenido del webhook (las notificaciones de QR no vienen firmadas). Lo usa solo como aviso y consulta el estado real de la orden con el token del comercio. Las órdenes usan el id del cobro como clave de idempotencia, así que reintentar no cobra dos veces.

Los tests usan un Mercado Pago falso (`apps/server/test/fake-mercadopago.ts`) con los mismos endpoints. **Antes de cobrar de verdad, probá un cobro real chico con tu cuenta:** el circuito contra la API real no se puede verificar desde los tests.

## App de escritorio

Requisitos: Rust y las dependencias de sistema de [Tauri 2](https://v2.tauri.app/start/prerequisites/). En Linux: `webkit2gtk-4.1`.

```bash
npm run dev -w @misventas/desktop                                            # desarrollo (usa el servidor de Vite)
VITE_API_URL=https://TU-DOMINIO npm run build -w @misventas/desktop          # instaladores en apps/desktop/src-tauri/target/release/bundle
```

`VITE_API_URL` es obligatoria para que la app de escritorio sincronice: su interfaz va empaquetada adentro y no tiene un `/api` propio.

Los instaladores de Windows (`.msi`/`.exe`) y macOS (`.dmg`) se generan en esos sistemas. Para eso está el workflow **Instaladores de escritorio** (`.github/workflows/desktop.yml`):
1. Subí el repositorio a GitHub.
2. Cargá la variable `MISVENTAS_API_URL`.
3. Corré el workflow desde la pestaña Actions.

El workflow **Tests** (`ci.yml`) corre tipos, unitarios (también contra PostgreSQL), Rust y punta a punta en cada push.

**Impresión:** en Ajustes → Tickets se elige la ticketera:
- **USB o del sistema:** tiene que estar instalada en el sistema operativo. Se manda en modo crudo: CUPS `application/vnd.cups-raw`, o RAW en el spooler de Windows.
- **De red:** IP y puerto 9100.

La impresión directa usa la página de códigos PC850 (ñ y acentos) y puede abrir el cajón conectado a la ticketera. Desde el navegador se imprime con la ventana de impresión.

Playwright usa `/usr/bin/chromium` si existe (o `CHROMIUM_PATH`). Si no, instalá el navegador con `npx playwright install chromium`.

## Cómo funciona la sincronización

1. **Cada escritura local queda marcada como pendiente en la misma transacción** (hooks de Dexie: `_dirty`, `_df` = campos tocados, `_rev`). Si la app se cierra, no se pierde nada.
2. **Subir:** se envían solo los campos modificados. El servidor los fusiona por campo (`data || patch`) y asigna un número de secuencia (`seq`). Las escrituras de cada comercio se serializan con un advisory lock, así el orden de `seq` coincide con el de commit y nadie se saltea un cambio.
3. **Bajar:** cada dispositivo pide "todo lo que cambió después de mi cursor". Lo que llega no pisa los campos editados localmente que todavía no se subieron.
4. **El stock no se sincroniza.** Se sincronizan los movimientos (ventas, compras, ajustes) y cada dispositivo recalcula su stock. Si dos cajas venden offline la última unidad, el stock queda en −1 para revisar y no se pierde ninguna venta.
5. **Cuándo sincroniza:** al guardar algo (en ~1 s), cada 30 s, al volver internet y cuando el servidor avisa por Server-Sent Events que otro dispositivo cambió algo.

## Decisiones

- **Dinero en centavos enteros.** IDs UUID v7 generados en el dispositivo.
- **Dispositivos con token largo y revocable** (se guarda solo su hash) en lugar de JWT con refresh. Desvincular un equipo corta el acceso en el momento.
- **Contraseña de la cuenta con scrypt.** El inicio de sesión está limitado a 10 intentos por minuto.
- **El PIN es un control de mostrador.** Identifica quién atiende y limita lo que puede hacer cada rol. Los permisos se aplican en la app; la seguridad de los datos la da la cuenta del dueño, que es la única que puede vincular dispositivos.
- **La venta guarda una copia de nombre, precio y costo.** Los cambios de precio no alteran el historial.
- **Datos de la Fase 1:** la base local se migra sola. Los proveedores pasan de texto a entidad, se crea el usuario dueño y la configuración se separa en datos del comercio (compartidos) y preferencias del dispositivo.
