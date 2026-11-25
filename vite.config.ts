import { defineConfig } from "vitest/config";

export default defineConfig({
  // main.ts loads Rapier with a top-level await (heavy debris, Spec 04 v2.0).
  build: { target: "es2022" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
});
