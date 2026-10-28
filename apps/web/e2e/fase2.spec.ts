import { expect, test, type Browser, type Page } from "@playwright/test";

const favorito = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name} \\$`) });

async function onboard(page: Page, opts: { owner?: string; pin?: string } = {}) {
  await page.goto("/");
  await page.getByRole("button", { name: /Empiezo acá/ }).click();
  await page.getByLabel("¿Cómo se llama tu kiosco?").fill("Kiosco Sincronizado");
  await page.getByLabel("¿Cómo te llamás?").fill(opts.owner ?? "Ana");
  if (opts.pin) await page.getByLabel(/Elegí un PIN/).fill(opts.pin);
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByLabel("¿Con cuánto efectivo empieza el cajón?").fill("5000");
  await page.getByRole("button", { name: /Empezar a vender/ }).click();
  await expect(page.getByText("Listo para vender")).toBeVisible();
}

async function cobrar(page: Page, entrega: string) {
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page.getByLabel("¿Con cuánto paga?").fill(entrega);
  await page.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(page.getByText("Venta registrada")).toBeVisible();
}

async function goto(page: Page, route: string) {
  await page.goto(`/#/${route}`);
}

const uniqueEmail = () => `kiosco-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@prueba.com`;

async function newDevice(browser: Browser, isMobile: boolean) {
  const context = await browser.newContext(isMobile ? { viewport: { width: 412, height: 839 }, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 820 } });
  return context.newPage();
}

test("dos dispositivos comparten ventas, stock y precios", async ({ page, browser, isMobile }) => {
  const email = uniqueEmail();

  // Dispositivo A: la PC del mostrador crea la cuenta.
  await onboard(page);
  await goto(page, "ajustes");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Contraseña").fill("clave-segura");
  await dialog.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page.getByText(/esta caja es D01/)).toBeVisible();
  await expect(page.getByRole("status").first()).toContainText(/Sincronizado/);

  await goto(page, "vender");
  await favorito(page, "Gaseosa cola 500 ml").click();
  await cobrar(page, "1500");
  await expect(page.getByRole("status").first()).toContainText(/Sincronizado/);

  // Dispositivo B: el celular del dueño inicia sesión y baja todo.
  const phone = await newDevice(browser, !isMobile);
  await phone.goto("/");
  await phone.getByRole("button", { name: /Ya lo uso en otro equipo/ }).click();
  const login = phone.getByRole("dialog");
  await login.getByLabel("Email").fill(email);
  await login.getByLabel("Contraseña").fill("clave-segura");
  await login.getByRole("button", { name: "Entrar" }).click();
  await expect(phone.getByText("Listo para vender")).toBeVisible({ timeout: 15_000 });

  await goto(phone, "productos");
  await phone.getByLabel("Buscar producto").fill("gaseosa cola");
  await expect(phone.getByRole("button", { name: /Gaseosa cola 500 ml/ })).toContainText("23 u.");

  await goto(phone, "ventas");
  await expect(phone.getByText(/D01-000001/)).toBeVisible();

  // B cambia un precio: A lo ve sin recargar (aviso en tiempo real).
  await goto(phone, "productos");
  await phone.getByLabel("Buscar producto").fill("gaseosa cola");
  await phone.getByRole("button", { name: /Gaseosa cola 500 ml/ }).click();
  await phone.getByRole("dialog").getByLabel("Precio de venta").fill("1700");
  await phone.getByRole("dialog").getByRole("button", { name: "Guardar" }).click();

  await goto(page, "vender");
  await expect(favorito(page, "Gaseosa cola 500 ml")).toContainText("$ 1.700", { timeout: 15_000 });

  // B vende desde el celular (con su propia caja y numeración): el stock baja en A.
  await goto(phone, "vender");
  await favorito(phone, "Gaseosa cola 500 ml").click();
  await phone.getByRole("button", { name: /^Cobrar/ }).click();
  await phone.getByRole("dialog", { name: "Abrir la caja" }).getByRole("button", { name: "Abrir caja" }).click();
  await phone.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(phone.getByText("Venta registrada")).toBeVisible();

  await goto(page, "productos");
  await page.getByLabel("Buscar producto").fill("gaseosa cola");
  await expect(page.getByRole("button", { name: /Gaseosa cola 500 ml/ })).toContainText("22 u.", { timeout: 15_000 });
  await goto(page, "ventas");
  await expect(page.getByText(/D02-000001/)).toBeVisible({ timeout: 15_000 });
  await phone.context().close();
});

test("fiado: se anota en la cuenta del cliente y el pago entra a la caja", async ({ page }) => {
  await onboard(page);
  await favorito(page, "Alfajor triple").click();
  await favorito(page, "Gaseosa cola 500 ml").click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page.getByRole("radio", { name: "Fiado" }).click();
  await expect(page.getByRole("button", { name: /Confirmar cobro/ })).toBeDisabled();
  await page.getByLabel("¿A quién se le fía?").fill("Juan del 3.º B");
  await page.getByRole("button", { name: /Nuevo cliente: Juan del 3.º B/ }).click();
  await expect(page.getByText("Se le fía a Juan del 3.º B")).toBeVisible();
  await page.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(page.getByText("Venta registrada")).toBeVisible();

  await goto(page, "clientes");
  await expect(page.getByText("Te deben en total").locator("..")).toContainText("$ 2.800");
  await page.getByRole("button", { name: /Juan del 3.º B/ }).click();
  await page.getByRole("button", { name: "Registrar pago" }).click();
  const pago = page.getByRole("dialog", { name: /Pago de/ });
  await pago.getByLabel("¿Cuánto paga?").fill("1000");
  await pago.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByRole("dialog", { name: "Juan del 3.º B", exact: true })).toContainText("$ 1.800");
  await page.keyboard.press("Escape");

  await goto(page, "caja");
  // 5.000 de apertura + 1.000 del pago del fiado (la venta fiada no entra al cajón).
  await expect(page.getByText("Efectivo que tiene que haber en el cajón").locator("..")).toContainText("$ 6.000");
  await expect(page.getByText("Otros medios").locator("..")).toContainText("Fiado");
});

test("roles: el cajero entra con PIN y no puede anular, descontar ni ver reportes", async ({ page, isMobile }) => {
  await onboard(page, { owner: "Ana", pin: "1234" });
  await goto(page, "ajustes");
  await page.getByRole("button", { name: "Nuevo usuario" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo usuario" });
  await dialog.getByLabel("Nombre").fill("Luis");
  await dialog.getByLabel(/PIN de 4 números/).fill("5678");
  await dialog.getByRole("button", { name: "Guardar" }).click();

  // Cambiar de usuario desde la barra de estado.
  await page.getByRole("button", { name: /Ana/ }).first().click();
  await expect(page.getByText("¿Quién atiende?")).toBeVisible();
  await page.getByRole("button", { name: /Luis/ }).click();
  for (const d of "1111") await page.getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByText("PIN incorrecto")).toBeVisible();
  for (const d of "5678") await page.getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByText("Listo para vender")).toBeVisible();

  await favorito(page, "Agua mineral 500 ml").click();
  await expect(page.getByRole("button", { name: /Descuento/ })).toHaveCount(0);
  await cobrar(page, "900");

  if (isMobile) await page.getByRole("button", { name: "Más" }).click();
  await expect(page.getByRole("button", { name: "Reportes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Proveedores" })).toHaveCount(0);
  if (isMobile) await page.keyboard.press("Escape");

  await goto(page, "ventas");
  await page.getByRole("button", { name: /Agua mineral 500 ml/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Atendió Luis");
  await expect(page.getByRole("button", { name: /Anular/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await goto(page, "reportes"); // link directo: no se permite
  await expect(page.getByText("Listo para vender")).toBeVisible();
});

test("proveedores: arma el pedido con lo que falta", async ({ page }) => {
  await onboard(page);
  await goto(page, "proveedores");
  await page.getByRole("button", { name: /Golosinas del Sur/ }).click();
  const detail = page.getByRole("dialog", { name: "Golosinas del Sur" });
  await expect(detail).toContainText("Papas fritas 80 g");
  await expect(detail.getByLabel("Cantidad a pedir de Papas fritas 80 g")).toHaveValue("5");
});

test("reportes muestran lo vendido en el período", async ({ page }) => {
  await onboard(page);
  await favorito(page, "Cigarrillos atado 20").click();
  await cobrar(page, "5000");
  await goto(page, "reportes");
  await page.getByRole("radio", { name: "Hoy" }).click();
  await expect(page.getByText("Vendido", { exact: true }).locator("..")).toContainText("$ 3.800");
  await expect(page.getByText("Lo más vendido").locator("..")).toContainText("Cigarrillos atado 20");
  await page.getByRole("radio", { name: "7 días" }).click();
  await expect(page.getByText("Ventas por día")).toBeVisible();
});
