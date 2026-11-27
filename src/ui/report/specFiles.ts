/**
 * The spec documents and app version for the report's metadata and Methods (Spec 16), read at
 * build time: docs/specs/*.md bundled as text, the commit from the build.
 */
import { parseSpecDoc } from "../../sim/report/specDocs";
import type { SpecDoc } from "../../sim/report/specDocs";

const files = import.meta.glob("../../../docs/specs/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const SPEC_DOCS: readonly SpecDoc[] = Object.entries(files)
  .map(([path, text]) => parseSpecDoc(path.split("/").pop()!, text))
  .sort((a, b) => a.file.localeCompare(b.file));

/** The build's commit (vite.config defines it), or "dev". */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
