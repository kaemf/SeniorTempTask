import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    // Mirror the "@/*" path alias from tsconfig.json.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["test/public/**/*.test.tsx"],
    environment: "jsdom",
    restoreMocks: true,
    clearMocks: true,
  },
});
