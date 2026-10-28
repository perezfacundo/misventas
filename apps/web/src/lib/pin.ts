/**
 * PIN de 4 dígitos con PBKDF2 (WebCrypto). Sirve para que cada persona entre con su usuario en el mostrador;
 * no reemplaza la contraseña de la cuenta, que es la que protege los datos en el servidor.
 */
const ITERATIONS = 120_000;

const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(await derive(pin, salt, ITERATIONS))}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  return toB64(await derive(pin, fromB64(salt), Number(iter))) === hash;
}

export const isValidPin = (pin: string) => /^\d{4}$/.test(pin);
