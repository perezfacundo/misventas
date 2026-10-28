import { defineConfig } from "vitest/config";

// Los archivos comparten la base (PGlite o TEST_DATABASE_URL) y la vacían entre tests: van de a uno.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 15_000, hookTimeout: 30_000 } });
