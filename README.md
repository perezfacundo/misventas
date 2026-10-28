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

Lo que sigue (Fase 3: Mercado Pago integrado y app de escritorio con Tauri; Fase 4: factura electrónica ARCA opcional) está en el documento de planificación.

## Estructura

```
packages/core   Dominio puro y testeado: dinero, carrito, cobro, stock, precios, caja, fiado, permisos, reportes, tipos de sync
apps/web        App React + Vite + Tailwind, PWA, base local IndexedDB (Dexie) y motor de sincronización
apps/server     API Fastify + Drizzle sobre PostgreSQL (o PGlite embebido si no hay DATABASE_URL)
```

## Comandos

```bash
npm install
npm run server     # API en http://127.0.0.1:3000 (PGlite en apps/server/data/, sin instalar nada)
npm run dev        # app en http://localhost:5173 (le pasa /api al servidor)
npm test           # tests unitarios: core, server y web
npm run e2e        # punta a punta en escritorio y celular (levanta servidor y app solos)
npm run typecheck
```

**Producción:** `npm run build` y después `npm start -w @misventas/server`. Un solo proceso sirve la app y la API.

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | PostgreSQL. Sin ella se usa PGlite en `DATA_DIR`. |
| `PORT`, `HOST` | Por defecto `3000` y `127.0.0.1`. Detrás de un proxy con HTTPS, usá `HOST=0.0.0.0`. |
| `DATA_DIR` | Carpeta de PGlite. |
| `WEB_DIST` | Build de la app web que se sirve. Por defecto `apps/web/dist`. |

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
