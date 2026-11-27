import { defineConfig } from "vitest/config";

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/; the deploy workflow sets PAGES_BASE.
  // Locally (dev server, tests, plain builds) the app lives at the root.
  base: process.env.PAGES_BASE ?? "/",
  // main.ts loads Rapier with a top-level await (heavy debris, Spec 04 v2.0).
  build: { target: "es2022" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
});
