import { useLiveQuery } from "dexie-react-hooks";
import { pesos } from "@misventas/core";
import { db, type BusinessSettings, type DeviceSettings, type Settings } from "../db";

const DEFAULT_BUSINESS: Omit<BusinessSettings, "id"> = {
  businessName: "",
  address: "",
  taxId: "",
  ticketFooter: "¡Gracias por tu compra!",
  priceRounding: pesos(10),
  enabledMethods: ["efectivo", "debito", "credito", "transferencia", "mercadopago", "fiado"],
};

const DEFAULT_DEVICE: DeviceSettings = {
  devicePrefix: "D01",
  textSize: "normal",
  theme: "auto",
  autoPrint: false,
  paperWidth: 58,
  onboarded: false,
};

const DEVICE_KEYS = new Set<string>(Object.keys(DEFAULT_DEVICE));

/** Configuración combinada: la del comercio (compartida entre cajas) más la de este dispositivo. */
export async function getSettings(): Promise<Settings> {
  const [business, device] = await Promise.all([db.business.get("business"), db.meta.get("settings")]);
  const { id: _id, _dirty, _df, _rev, ...shared } = { ...DEFAULT_BUSINESS, id: "business" as const, ...business };
  return { ...shared, ...DEFAULT_DEVICE, ...(device?.value as Partial<DeviceSettings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const devicePatch: Record<string, unknown> = {};
  const businessPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) (DEVICE_KEYS.has(k) ? devicePatch : businessPatch)[k] = v;
  await db.transaction("rw", db.meta, db.business, async () => {
    if (Object.keys(devicePatch).length) {
      const current = ((await db.meta.get("settings"))?.value ?? {}) as Partial<DeviceSettings>;
      await db.meta.put({ key: "settings", value: { ...DEFAULT_DEVICE, ...current, ...devicePatch } });
    }
    if (Object.keys(businessPatch).length) {
      const existing = await db.business.get("business");
      if (existing) await db.business.update("business", businessPatch as Partial<BusinessSettings>);
      else await db.business.add({ ...DEFAULT_BUSINESS, ...businessPatch, id: "business" });
    }
  });
  applyUiPrefs(await getSettings());
}

/** undefined mientras carga. */
export function useSettings(): Settings | undefined {
  return useLiveQuery(getSettings, []);
}

/** Aplica tema y tamaño de texto, y los guarda en localStorage para el arranque sin parpadeo. */
export function applyUiPrefs(s: Pick<Settings, "theme" | "textSize">): void {
  const root = document.documentElement;
  if (s.theme === "claro") root.dataset.theme = "light";
  else if (s.theme === "oscuro") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  root.dataset.size = s.textSize;
  try {
    localStorage.setItem("misventas:ui", JSON.stringify({ theme: s.theme, textSize: s.textSize }));
  } catch {
    // Sin localStorage (modo privado): solo se pierde el arranque sin parpadeo.
  }
}

/** Numeración correlativa de comprobantes internos, por dispositivo. */
export async function nextReceiptNumber(): Promise<number> {
  const row = await db.meta.get("receiptCounter");
  const n = ((row?.value as number | undefined) ?? 0) + 1;
  await db.meta.put({ key: "receiptCounter", value: n });
  return n;
}
