import { defineConfig, devices } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Usa el Chromium del sistema si existe; si no, el que descarga Playwright (npx playwright install chromium).
const systemChromium = process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
// Base de datos nueva en cada corrida: los tests crean cuentas con emails únicos, pero así no se acumula nada.
const dataDir = mkdtempSync(join(tmpdir(), "misventas-e2e-"));
const API_PORT = 3100;
export const FAKE_MP_PORT = 3101;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:4173",
    locale: "es-AR",
    launchOptions: systemChromium ? { executablePath: systemChromium } : {},
  },
  projects: [
    { name: "escritorio", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 820 } } },
    { name: "celular", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      // Mercado Pago falso: los tests simulan que el cliente paga y le avisa al servidor por webhook.
      command: "node ../server/test/fake-mercadopago.ts",
      url: `http://127.0.0.1:${FAKE_MP_PORT}/__fake/orders`,
      env: { PORT: String(FAKE_MP_PORT), WEBHOOK_URL: `http://127.0.0.1:${API_PORT}/api/webhooks/mercadopago` },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node ../server/src/main.ts",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: {
        PORT: String(API_PORT), DATA_DIR: dataDir, DISABLE_RATE_LIMIT: "1", WEB_DIST: "", NODE_ENV: "test",
        APP_SECRET: "secreto-e2e", MP_API_URL: `http://127.0.0.1:${FAKE_MP_PORT}`,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run build && npm run preview -- --port 4173 --strictPort",
      url: "http://localhost:4173",
      env: { API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
