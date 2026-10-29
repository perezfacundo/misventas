import { expect, test, type Browser, type Page } from "@playwright/test";

const favorito = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name} \\$`) });

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Empiezo acá/ }).click();
  await page.getByLabel("¿Cómo se llama tu kiosco?").fill("Kiosco Fase 5");
  await page.getByLabel("¿Cómo te llamás?").fill("Ana");
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByRole("button", { name: /Empezar a vender/ }).click();
  await expect(page.getByText("Listo para vender")).toBeVisible();
}

async function cobrar(page: Page) {
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(page.getByText("Venta registrada")).toBeVisible();
}

async function pickProduct(page: Page, query: string, name: string) {
  await page.getByLabel("Buscar producto para agregar").fill(query);
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

test("promociones: 2×1 y combo se aplican solos al vender", async ({ page }) => {
  await onboard(page);
  await page.goto("/#/promociones");
  await page.getByRole("button", { name: "Nueva promoción" }).click();
  let dialog = page.getByRole("dialog", { name: "Nueva promoción" });
  await dialog.getByLabel(/Nombre/).fill("2×1 alfajores");
  await pickProduct(page, "alfajor simple", "Alfajor simple");
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Activa ahora")).toBeVisible();

  await page.getByRole("button", { name: "Nueva promoción" }).click();
  dialog = page.getByRole("dialog", { name: "Nueva promoción" });
  await dialog.getByLabel(/Nombre/).fill("Combo merienda");
  await dialog.getByRole("radio", { name: "Combo a precio fijo" }).click();
  await pickProduct(page, "gaseosa cola", "Gaseosa cola 500 ml");
  await pickProduct(page, "alfajor triple", "Alfajor triple");
  await dialog.getByLabel("Precio del combo").fill("2400");
  await expect(dialog.getByText(/ahorra \$ 400/)).toBeVisible();
  await dialog.getByRole("button", { name: "Guardar" }).click();

  await page.goto("/#/vender");
  await favorito(page, "Alfajor simple").click();
  await favorito(page, "Alfajor simple").click();
  await favorito(page, "Gaseosa cola 500 ml").click();
  await favorito(page, "Alfajor triple").click();
  // 2 × 800 + 1500 + 1300 = 4400; 2×1 −800; combo −400 → 3200
  await expect(page.getByText("2×1 alfajores −$ 800")).toBeVisible();
  await expect(page.getByText("Combo merienda −$ 400")).toBeVisible();
  await expect(page.getByText("$ 3.200").first()).toBeVisible();
  await cobrar(page);

  await page.goto("/#/hoy");
  await expect(page.getByText("Vendido", { exact: true }).locator("..")).toContainText("$ 3.200");
});

test("vencimientos: se cargan al ingresar mercadería, avisan y se dan de baja", async ({ page }) => {
  await onboard(page);
  await page.goto("/#/productos");
  await page.getByLabel("Buscar producto").fill("gaseosa lima");
  await page.getByRole("button", { name: /Gaseosa lima 500 ml/ }).click();
  await page.getByRole("dialog").getByText("Controlar vencimientos").click();
  await page.getByRole("dialog").getByRole("button", { name: "Guardar" }).click();

  const d = new Date(Date.now() + 2 * 86_400_000);
  const inTwoDays = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await page.getByRole("button", { name: /Llegó mercadería/ }).click();
  const purchase = page.getByRole("dialog", { name: "Ingreso de mercadería" });
  await purchase.getByLabel("Buscar producto").fill("gaseosa lima");
  await purchase.getByLabel("Buscar producto").press("Enter");
  await purchase.getByLabel("Cantidad de Gaseosa lima 500 ml").fill("6");
  await expect(purchase.getByRole("button", { name: "Sumar al stock" })).toBeDisabled();
  await purchase.getByLabel("Vencimiento de Gaseosa lima 500 ml").fill(inTwoDays);
  await purchase.getByRole("button", { name: "Sumar al stock" }).click();

  await page.getByRole("tab", { name: /Por vencer \(1\)/ }).click();
  await expect(page.getByText(/vence en 2 días/)).toBeVisible();
  await expect(page.getByText(/quedarían 6 unidades/)).toBeVisible();
  await page.getByRole("button", { name: "Dar de baja" }).click();
  await page.getByRole("dialog").getByLabel("Unidades").fill("2");
  await page.getByRole("dialog").getByRole("button", { name: "Dar de baja" }).click();
  await expect(page.getByText(/quedarían 4 unidades/)).toBeVisible();

  await page.goto("/#/hoy");
  await expect(page.getByText("Por vencer esta semana")).toBeVisible();
});

async function newDevice(browser: Browser) {
  return (await browser.newContext({ viewport: { width: 1366, height: 820 } })).newPage();
}

test("sucursales: cada una con su stock, y la mercadería se envía y se recibe", async ({ page, browser, isMobile }) => {
  test.skip(isMobile, "Dos dispositivos: se prueba una vez");
  const email = `suc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@prueba.com`;
  await onboard(page);
  await page.goto("/#/ajustes");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByRole("dialog").getByLabel("Email").fill(email);
  await page.getByRole("dialog").getByLabel("Contraseña").fill("clave-segura");
  await page.getByRole("dialog").getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page.getByText(/esta caja es D01/)).toBeVisible();
  await page.getByRole("button", { name: "Nueva sucursal" }).click();
  await page.getByRole("dialog").getByLabel("Nombre").fill("Centro");
  await page.getByRole("dialog").getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText(/Kiosco Fase 5 · Principal/)).toBeVisible();

  // Segundo dispositivo: se vincula y pasa a la sucursal Centro (sin stock propio todavía).
  const centro = await newDevice(browser);
  await centro.goto("/");
  await centro.getByRole("button", { name: /Ya lo uso en otro equipo/ }).click();
  await centro.getByRole("dialog").getByLabel("Email").fill(email);
  await centro.getByRole("dialog").getByLabel("Contraseña").fill("clave-segura");
  await centro.getByRole("dialog").getByRole("button", { name: "Entrar" }).click();
  await expect(centro.getByText("Listo para vender")).toBeVisible({ timeout: 15_000 });
  await centro.goto("/#/ajustes");
  await centro.getByLabel("Esta caja está en").selectOption({ label: "Centro" });
  await expect(centro.getByText(/Kiosco Fase 5 · Centro/)).toBeVisible();
  await centro.goto("/#/productos");
  await centro.getByLabel("Buscar producto").fill("gaseosa cola");
  await expect(centro.getByRole("button", { name: /Gaseosa cola 500 ml/ })).toContainText("Sin stock");

  // La principal manda 6 gaseosas a Centro.
  await page.goto("/#/productos");
  await page.getByRole("button", { name: /Enviar a otra sucursal/ }).click();
  const send = page.getByRole("dialog", { name: "Enviar a otra sucursal" });
  await send.getByLabel("Buscar producto para enviar").fill("gaseosa cola");
  await send.getByLabel("Buscar producto para enviar").press("Enter");
  await send.getByLabel("Cantidad a enviar de Gaseosa cola 500 ml").fill("6");
  await send.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByText(/Enviado a Centro/)).toBeVisible();
  await page.getByLabel("Buscar producto").fill("gaseosa cola");
  await expect(page.getByRole("button", { name: /Gaseosa cola 500 ml/ })).toContainText("18 u.");

  // Centro lo recibe (llegan 5 de 6).
  await expect(centro.getByText(/Llegó un envío/)).toBeVisible({ timeout: 15_000 });
  await centro.getByRole("button", { name: "Recibir" }).click();
  await centro.getByRole("dialog").getByLabel("Recibido de Gaseosa cola 500 ml").fill("5");
  await centro.getByRole("dialog").getByRole("button", { name: "Confirmar recepción" }).click();
  await centro.getByLabel("Buscar producto").fill("gaseosa cola");
  await expect(centro.getByRole("button", { name: /Gaseosa cola 500 ml/ })).toContainText("5 u.");

  // La principal ve que ya lo recibieron.
  await expect(page.getByText(/Enviado a Centro/)).toHaveCount(0, { timeout: 15_000 });
  await centro.context().close();
});
