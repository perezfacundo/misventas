/**
 * UUID v7: ordenable por tiempo y generado en el dispositivo,
 * así cada caja puede crear registros offline sin chocar con otras.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "D01-000123": el prefijo por dispositivo evita números repetidos entre cajas offline. */
export function formatReceiptNumber(devicePrefix: string, n: number): string {
  return `${devicePrefix}-${String(n).padStart(6, "0")}`;
}
