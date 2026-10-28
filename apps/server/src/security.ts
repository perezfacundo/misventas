import { createHash, randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";

const scryptAsync = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, PARAMS);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, PARAMS);
  return timingSafeEqual(key, expected);
}

/** Token de dispositivo: largo, aleatorio y revocable. En la base solo se guarda su hash. */
export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
