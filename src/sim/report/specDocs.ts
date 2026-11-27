/**
 * Spec documents for the report's Methods section (Spec 16): each spec's title, version and
 * status, and its Simplifications list, parsed from the markdown in docs/specs. Pure: the app
 * reads the files at build time, tests and scripts read them from disk.
 */
export interface SpecDoc {
  /** File name, e.g. "16-storm-report.md". */
  file: string;
  title: string;
  version: string;
  approved: boolean;
  /** Simplifications / out of scope, one entry per bullet (markdown removed). */
  simplifications: string[];
}

/** Plain text from a line of markdown: links, code and emphasis markers removed. */
export function plainText(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSpecDoc(file: string, text: string): SpecDoc {
  const lines = text.split(/\r?\n/);
  const title = plainText((lines.find((l) => l.startsWith("# ")) ?? file).replace(/^#\s+/, ""));
  const status = lines.find((l) => l.startsWith("Status:")) ?? "";
  const version = /\(v([\d.]+)\)/.exec(status)?.[1] ?? "?";
  const approved = /Status:\s*Approved/.test(status);
  const simplifications: string[] = [];
  const at = lines.findIndex((l) => /^##\s+Simplifications/.test(l));
  if (at >= 0) {
    let cur: string | null = null;
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^##\s/.test(l)) break;
      if (/^\s*-\s+/.test(l)) {
        if (cur !== null) simplifications.push(plainText(cur));
        cur = l.replace(/^\s*-\s+/, "");
      } else if (cur !== null && l.trim()) cur += " " + l.trim();
      else if (cur !== null && !l.trim()) {
        simplifications.push(plainText(cur));
        cur = null;
      }
    }
    if (cur !== null) simplifications.push(plainText(cur));
  }
  return { file, title, version, approved, simplifications };
}

/** Spec file → version, for the run metadata (Spec 16). */
export function specVersions(docs: readonly SpecDoc[]): Record<string, string> {
  return Object.fromEntries(docs.map((d) => [d.file, d.version]));
}
