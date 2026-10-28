import { expect, test, type Page } from "@playwright/test";

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Empiezo acá/ }).click();
  await page.getByLabel("¿Cómo se llama tu kiosco?").fill("Kiosco de Prueba");
  await page.getByLabel("¿Cómo te llamás?").fill("Ana");
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByRole("button", { name: /Sí, cargá ejemplos/ }).click();
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByLabel("¿Con cuánto efectivo empieza el cajón?").fill("5000");
  await page.getByRole("button", { name: /Empezar a vender/ }).click();
  await expect(page.getByText("Listo para vender")).toBeVisible();
}

/** Botón de favorito: "Nombre $ precio" (evita confundirlo con "Quitar Nombre" del carrito). */
const favorito = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name} \\$`) });

async function cobrarEnEfectivo(page: Page, entrega: string) {
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page.getByLabel("¿Con cuánto paga?").fill(entrega);
  await page.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(page.getByText("Venta registrada")).toBeVisible();
}

test("primera venta en efectivo: vuelto, stock y resumen del día", async ({ page }) => {
  await onboard(page);

  await favorito(page, "Gaseosa cola 500 ml").click();
  await favorito(page, "Gaseosa cola 500 ml").click();
  await favorito(page, "Alfajor simple").click();
  await expect(page.getByText("$ 3.800").first()).toBeVisible();

  await cobrarEnEfectivo(page, "5000");
  await expect(page.getByText("$ 1.200").first()).toBeVisible(); // vuelto

  await page.goto("/#/productos");
  await page.getByLabel("Buscar producto").fill("gaseosa cola");
  await expect(page.getByRole("button", { name: /Gaseosa cola 500 ml/ })).toContainText("22 u.");

  await page.goto("/#/hoy");
  await expect(page.getByText("Vendido").locator("..")).toContainText("$ 3.800");
  await expect(page.getByText("Ganancia estimada").locator("..")).toContainText("$ 1.420");

  await page.goto("/#/caja");
  await expect(page.getByText("Efectivo que tiene que haber en el cajón").locator("..")).toContainText("$ 8.800");
});

test("buscar con el lector: código de barras y multiplicador", async ({ page }) => {
  await onboard(page);
  const search = page.getByLabel("Buscar producto o escanear código");
  await search.fill("3*2000000000007");
  await search.press("Enter");
  await expect(page.getByRole("group", { name: "Cantidad de Alfajor simple" })).toContainText("3");

  await search.fill("chicles");
  await search.press("Enter");
  await expect(page.getByRole("region", { name: "Productos de esta venta" })).toContainText("Chicles de menta");
  await expect(page.getByText("$ 3.000").first()).toBeVisible();
});

test("pago mixto: efectivo y débito", async ({ page }) => {
  await onboard(page);
  await favorito(page, "Cigarrillos atado 20").click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page.getByLabel("¿Con cuánto paga?").fill("1000");
  await expect(page.getByText("Faltan")).toContainText("$ 2.800");
  await page.getByRole("button", { name: /Pagar el resto con otro medio/ }).click();
  await page.getByRole("radio", { name: "Débito" }).click();
  await expect(page.getByText("Pago completo, sin vuelto.")).toBeVisible();
  await page.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(page.getByText("Venta registrada")).toBeVisible();
  await expect(page.getByText(/Efectivo \+ Débito/)).toBeVisible();
});

test("anular una venta devuelve el stock", async ({ page }) => {
  await onboard(page);
  await favorito(page, "Agua mineral 500 ml").click();
  await cobrarEnEfectivo(page, "900");

  await page.goto("/#/ventas");
  await page.getByRole("button", { name: /Agua mineral 500 ml/ }).click();
  await page.getByRole("button", { name: /Anular/ }).click();
  await page.getByLabel("¿Por qué se anula?").fill("Prueba");
  await page.getByRole("button", { name: "Confirmar anulación" }).click();
  await expect(page.getByText("Anulada").first()).toBeVisible();

  await page.goto("/#/productos");
  await page.getByLabel("Buscar producto").fill("agua mineral");
  await expect(page.getByRole("button", { name: /Agua mineral 500 ml/ })).toContainText("30 u.");
});

test("cierre de caja con faltante", async ({ page }) => {
  await onboard(page);
  await favorito(page, "Alfajor triple").click();
  await cobrarEnEfectivo(page, "2000");

  await page.goto("/#/caja");
  await page.getByRole("button", { name: /Cerrar caja/ }).click();
  await page.getByLabel("Efectivo contado").fill("6200");
  await expect(page.getByRole("dialog")).toContainText("Faltan $ 100");
  await page.getByRole("dialog").getByRole("button", { name: "Cerrar caja" }).click();
  await expect(page.getByText("La caja está cerrada")).toBeVisible();
  await expect(page.getByText("Cierres anteriores").locator("..")).toContainText("Faltan $ 100");
});

test("funciona sin internet y recupera el carrito", async ({ page, context }) => {
  await onboard(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);

  await context.setOffline(true);
  await expect(page.getByRole("status")).toContainText("Sin internet");
  await page.reload(); // la app la sirve el service worker, sin red
  await expect(page.getByText("Listo para vender")).toBeVisible();

  const search = page.getByLabel("Buscar producto o escanear código");
  await search.fill("encendedor");
  await search.press("Enter");
  await page.reload(); // cierre accidental
  await expect(page.getByText("Encendedor").first()).toBeVisible();
  await cobrarEnEfectivo(page, "1200");
});
