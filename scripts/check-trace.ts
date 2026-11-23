/**
 * Traceability check: every acceptance criterion in an Approved spec must appear
 * in at least one test name under tests/.
 *
 * Criteria are lines in a spec's "Acceptance criteria" section of the form:
 *   - **WIND-03**: ...
 * Tests reference them by name, e.g. test("WIND-03: ...").
 *
 * Draft specs are reported as warnings so work-in-progress doesn't fail verify.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const specsDir = join(root, "docs", "specs");
const testsDir = join(root, "tests");

const CRITERION = /^\s*-\s*\*\*([A-Z]+-\d{2,})\*\*/;
const STATUS = /^Status:\s*(\w+(?:\s\w+)?)/m;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const testText = walk(testsDir)
  .filter((f) => /\.test\.ts$/.test(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

let missingApproved = 0;
let missingDraft = 0;
const seen = new Map<string, string>();
let duplicate = false;

for (const file of readdirSync(specsDir).filter((f) => f.endsWith(".md")).sort()) {
  const text = readFileSync(join(specsDir, file), "utf8");
  const status = text.match(STATUS)?.[1] ?? "Unknown";
  const approved = status.startsWith("Approved");

  const section = text.split(/^## /m).find((s) => s.startsWith("Acceptance criteria"));
  if (!section) continue;

  const ids = section
    .split("\n")
    .map((l) => l.match(CRITERION)?.[1])
    .filter((id): id is string => !!id);
  if (ids.length === 0) continue;

  const missing: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      console.error(`✗ ${id} is defined in both ${seen.get(id)} and ${file}`);
      duplicate = true;
    }
    seen.set(id, file);
    if (!new RegExp(`\\b${id}\\b`).test(testText)) missing.push(id);
  }

  const covered = ids.length - missing.length;
  const tag = approved ? "approved" : status.toLowerCase();
  const mark = missing.length === 0 ? "✓" : approved ? "✗" : "·";
  console.log(`${mark} ${file} [${tag}] ${covered}/${ids.length} criteria have tests`);
  if (missing.length) console.log(`    missing: ${missing.join(", ")}`);

  if (approved) missingApproved += missing.length;
  else missingDraft += missing.length;
}

console.log(
  `\n${seen.size} criteria total. ${missingApproved} missing in approved specs, ` +
    `${missingDraft} pending in draft specs. (${relative(root, testsDir)}/)`,
);

if (missingApproved > 0 || duplicate) process.exit(1);
