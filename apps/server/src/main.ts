import { resolve } from "node:path";
import { buildApp } from "./app.ts";
import { openDb } from "./db.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const here = import.meta.dirname;

const { db, close } = await openDb({
  url: process.env.DATABASE_URL,
  dataDir: process.env.DATABASE_URL ? undefined : (process.env.DATA_DIR ?? resolve(here, "../data/pglite")),
});
const app = await buildApp({
  db,
  logger: process.env.NODE_ENV !== "test",
  webDist: process.env.WEB_DIST ?? resolve(here, "../../web/dist"),
  rateLimit: process.env.DISABLE_RATE_LIMIT !== "1",
});

await app.listen({ port, host });
console.log(`Mis Ventas: servidor en http://${host}:${port} (${process.env.DATABASE_URL ? "PostgreSQL" : "PGlite"})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await close();
    process.exit(0);
  });
}
