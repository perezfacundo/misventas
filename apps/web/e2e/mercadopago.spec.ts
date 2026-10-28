import { expect, test, type Page } from "@playwright/test";

const FAKE_MP = "http://127.0.0.1:3101";
const FAKE_TOKEN = "APP_USR-prueba-token-valido";
const favorito = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name} \\$`) });

/** Kiosco nuevo, con cuenta en la nube y Mercado Pago conectado (caja QR y posnet Point). */
async function setup(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Empiezo acá/ }).click();
  await page.getByLabel("¿Cómo se llama tu kiosco?").fill("Kiosco MP");
  await page.getByLabel("¿Cómo te llamás?").fill("Ana");
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByRole("button", { name: /Empezar a vender/ }).click();
  await expect(page.getByText("Listo para vender")).toBeVisible();

  await page.goto("/#/ajustes");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  const account = page.getByRole("dialog");
  await account.getByLabel("Email").fill(`mp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@prueba.com`);
  await account.getByLabel("Contraseña").fill("clave-segura");
  await account.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page.getByText(/esta caja es D01/)).toBeVisible();

  await page.getByRole("button", { name: "Conectar Mercado Pago" }).click();
  const dialog = page.getByRole("dialog", { name: "Conectar Mercado Pago" });
  await dialog.getByLabel("Access Token").fill("APP_USR-token-que-no-sirve");
  await dialog.getByRole("button", { name: "Conectar" }).click();
  await expect(dialog).toContainText("rechazó el token");
  await dialog.getByLabel("Access Token").fill(FAKE_TOKEN);
  await dialog.getByRole("button", { name: "Conectar" }).click();
  await expect(page.getByText(/Conectado a la cuenta KIOSCO_PRUEBA/)).toBeVisible();

  await page.getByLabel("Caja con QR").selectOption("CAJA1");
  await expect(page.getByText("Caja QR elegida")).toBeVisible();
}

async function startSale(page: Page, product: string) {
  await page.goto("/#/vender");
  await favorito(page, product).click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page.getByRole("radio", { name: "Mercado Pago" }).click();
}

const chargeId = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("misventas:mp-cobro") ?? "{}").id as string);

test("QR: el cliente paga y la venta se registra sola", async ({ page, request }) => {
  await setup(page);
  await startSale(page, "Gaseosa cola 500 ml");
  // Enter no debe registrar la venta como cobrada "a mano" sin querer.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Cobrar" })).toBeVisible();
  await expect(page.getByText(/Tocá «Cobrar con QR»/)).toBeVisible();
  await page.getByRole("button", { name: "Cobrar con QR" }).click();
  await expect(page.getByText("Esperando el pago…")).toBeVisible();
  await expect(page.getByRole("img", { name: /Código QR/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Confirmar cobro/ })).toBeDisabled();

  await request.post(`${FAKE_MP}/__fake/orders/${await chargeId(page)}/pay`);
  await expect(page.getByText("Venta registrada")).toBeVisible({ timeout: 10_000 });

  await page.goto("/#/ventas");
  await page.getByRole("button", { name: /Gaseosa cola 500 ml/ }).click();
  await expect(page.getByRole("dialog")).toContainText(/Mercado Pago \(op\. PAY01FAKE/);
});

test("si la app se cierra mientras el cliente paga, el cobro se retoma", async ({ page, request }) => {
  await setup(page);
  await startSale(page, "Alfajor triple");
  await page.getByRole("button", { name: "Cobrar con QR" }).click();
  await expect(page.getByText("Esperando el pago…")).toBeVisible();
  const id = await chargeId(page);

  await page.reload();
  await expect(page.getByText("Hay un cobro de Mercado Pago en curso.")).toBeVisible();
  await expect(page.getByText("Esperando el pago…")).toBeVisible();
  await request.post(`${FAKE_MP}/__fake/orders/${id}/pay`);
  await expect(page.getByText("Venta registrada")).toBeVisible({ timeout: 10_000 });
});

test("volver cancela el cobro pendiente; sin internet no se ofrece", async ({ page, context, request }) => {
  await setup(page);
  await startSale(page, "Agua mineral 500 ml");
  await page.getByRole("button", { name: "Cobrar con QR" }).click();
  await expect(page.getByText("Esperando el pago…")).toBeVisible();
  const id = await chargeId(page);
  await page.getByRole("button", { name: "Volver" }).click();
  await expect(page.getByRole("dialog", { name: "Cobrar" })).toHaveCount(0);
  const orders = (await (await request.get(`${FAKE_MP}/__fake/orders`)).json()) as { external_reference: string; status: string }[];
  expect(orders.find((o) => o.external_reference === id)?.status).toBe("canceled");

  await context.setOffline(true);
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page.getByRole("radio", { name: "Mercado Pago" }).click();
  await expect(page.getByRole("button", { name: "Cobrar con QR" })).toBeDisabled();
  await expect(page.getByText(/Sin internet no se puede cobrar con Mercado Pago/)).toBeVisible();
});

test.describe("Point", () => {
  // Hay un solo posnet falso: este test no corre en paralelo con otros que lo usen.
  test.skip(({ isMobile }) => isMobile, "El posnet se prueba una sola vez");

  test("se activa el modo integrado, el cobro va al posnet y si lo rechazan se avisa", async ({ page, request }) => {
    await setup(page);
    await page.getByLabel("Posnet Point").selectOption({ index: 1 });
    await expect(page.getByText(/no está en modo integrado/)).toBeVisible();
    await page.getByRole("button", { name: "Activar modo integrado" }).click();
    await expect(page.getByText(/Reiniciá el posnet/)).toBeVisible();
    await expect(page.getByText(/no está en modo integrado/)).toHaveCount(0);

    await startSale(page, "Cigarrillos atado 20");
    await page.getByRole("button", { name: "Cobrar con Point" }).click();
    await expect(page.getByText(/El cobro está en el posnet/)).toBeVisible();
    await request.post(`${FAKE_MP}/__fake/orders/${await chargeId(page)}/reject`);
    await expect(page.getByText(/El pago fue rechazado/)).toBeVisible({ timeout: 10_000 });

    // Se puede cobrar de otra forma.
    await page.getByRole("radio", { name: "Efectivo" }).click();
    await page.getByRole("button", { name: /Confirmar cobro/ }).click();
    await expect(page.getByText("Venta registrada")).toBeVisible();
  });
});
