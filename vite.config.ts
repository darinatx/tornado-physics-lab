import { execSync } from "node:child_process";
import { defineConfig } from "vitest/config";

/** The commit the app is built from, for the storm report's run metadata (Spec 16). */
function appVersion(): string {
  try {
    const hash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain -- src", { encoding: "utf8" }).trim() ? "+changes" : "";
    return hash + dirty;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/; the deploy workflow sets PAGES_BASE.
  // Locally (dev server, tests, plain builds) the app lives at the root.
  base: process.env.PAGES_BASE ?? "/",
  // main.ts loads Rapier with a top-level await (heavy debris, Spec 04 v2.0).
  build: { target: "es2022" },
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
});
