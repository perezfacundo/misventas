import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const FAKE_ARCA = "http://127.0.0.1:3102";
const favorito = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name} \\$`) });

/** CUIT válido distinto por test: el ARCA falso numera por CUIT. */
function randomCuit(): string {
  for (;;) {
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const sum = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((acc, w, i) => acc + w * Number(base[i]), 0);
    const mod = 11 - (sum % 11);
    if (mod !== 10) return base + (mod === 11 ? 0 : mod);
  }
}

/** Kiosco con cuenta en la nube y factura electrónica configurada, como lo haría el dueño. */
async function setup(page: Page, condicion: "monotributo" | "responsable_inscripto" = "monotributo") {
  await page.goto("/");
  await page.getByRole("button", { name: /Empiezo acá/ }).click();
  await page.getByLabel("¿Cómo se llama tu kiosco?").fill("Kiosco Fiscal");
  await page.getByLabel("¿Cómo te llamás?").fill("Ana");
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByRole("button", { name: /Siguiente/ }).click();
  await page.getByRole("button", { name: /Empezar a vender/ }).click();
  await expect(page.getByText("Listo para vender")).toBeVisible();

  await page.goto("/#/ajustes");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  const account = page.getByRole("dialog");
  await account.getByLabel("Email").fill(`arca-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@prueba.com`);
  await account.getByLabel("Contraseña").fill("clave-segura");
  await account.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page.getByText(/esta caja es D01/)).toBeVisible();

  // 1. Datos fiscales
  await page.getByLabel("CUIT", { exact: true }).fill(randomCuit());
  await page.getByLabel("Razón social o nombre").fill("Rosa Pérez");
  if (condicion === "responsable_inscripto") await page.getByRole("radio", { name: "IVA Responsable Inscripto" }).click();
  await page.getByLabel(/Punto de venta/).fill("3");
  await page.getByRole("button", { name: "Guardar datos fiscales" }).click();
  await expect(page.getByText("Datos fiscales guardados")).toBeVisible();

  // 2. Certificado: se descarga el pedido, "ARCA" lo firma y se sube el certificado.
  await page.getByRole("button", { name: "Generar pedido de certificado" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Descargar pedido/ }).click()]);
  const csrPem = await readFile((await download.path())!, "utf8");
  const { certPem } = (await (await fetch(`${FAKE_ARCA}/__fake/sign-csr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csrPem }) })).json()) as { certPem: string };
  await page.getByLabel("Certificado de ARCA").setInputFiles({ name: "misventas.crt", mimeType: "application/x-x509-ca-cert", buffer: Buffer.from(certPem) });
  await expect(page.getByText(/Certificado cargado, vence/)).toBeVisible();

  // 3. Prueba de conexión
  await page.getByRole("button", { name: "Probar conexión con ARCA" }).click();
  await expect(page.getByText(/Conexión correcta/)).toBeVisible();

  // 4. Facturar siempre
  await page.getByRole("radio", { name: "Siempre" }).click();
}

test("vender con factura C y anularla con nota de crédito", async ({ page }) => {
  await setup(page);
  await page.goto("/#/vender");
  await favorito(page, "Gaseosa cola 500 ml").click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await expect(page.getByLabel(/Hacer factura/)).toBeChecked();
  await expect(page.getByText("· Factura C")).toBeVisible();
  await page.getByLabel("¿Con cuánto paga?").fill("2000");
  await page.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(page.getByText("Venta registrada")).toBeVisible();
  await expect(page.getByText(/Factura C 00003-00000001/)).toBeVisible({ timeout: 15_000 });

  await page.goto("/#/ventas");
  await page.getByRole("button", { name: /Gaseosa cola 500 ml/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Factura C 00003-00000001");
  await page.getByRole("button", { name: /Anular/ }).click();
  await expect(page.getByText(/se va a emitir una nota de crédito/)).toBeVisible();
  await page.getByLabel("¿Por qué se anula?").fill("Error de cobro");
  await page.getByRole("button", { name: "Confirmar anulación" }).click();

  await page.getByRole("button", { name: /Gaseosa cola 500 ml/ }).click();
  await expect(page.getByRole("dialog")).toContainText(/Nota de crédito C 00003-00000001/, { timeout: 15_000 });
});

test("sin internet la venta se hace igual y la factura sale al volver la conexión", async ({ page, context }) => {
  await setup(page);
  await page.goto("/#/vender");
  await context.setOffline(true);
  await favorito(page, "Alfajor triple").click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(page.getByText("Venta registrada")).toBeVisible();
  await expect(page.getByText(/Factura pendiente/)).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText(/Factura C 00003-00000001/)).toBeVisible({ timeout: 20_000 });
});

test("responsable inscripto: factura A con CUIT del cliente", async ({ page }) => {
  await setup(page, "responsable_inscripto");
  await page.goto("/#/vender");
  await favorito(page, "Cigarrillos atado 20").click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await expect(page.getByText("· Factura B")).toBeVisible();
  await page.getByRole("radio", { name: "Con CUIT" }).click();
  await expect(page.getByText("· Factura A")).toBeVisible();
  await page.getByLabel("CUIT").fill("30-71234567-2");
  await expect(page.getByRole("button", { name: /Confirmar cobro/ })).toBeDisabled();
  await expect(page.getByText("Cargá un CUIT válido para la factura.")).toBeVisible();
  await page.getByLabel("CUIT").fill("30-71234567-1");
  await page.getByLabel(/Nombre o razón social/).fill("Proveedor SA");
  await page.getByRole("button", { name: /Confirmar cobro/ }).click();
  await expect(page.getByText(/Factura A 00003-00000001/)).toBeVisible({ timeout: 15_000 });
});
