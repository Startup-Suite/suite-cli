/**
 * Leak scanning: is a secret value present anywhere it should not be?
 *
 * Used by every stamp test that handles a token. A scan that has never been
 * shown to fire is not evidence of absence, so this helper has its own
 * planted-canary positive control (test/leak-scan.test.ts) and every caller is
 * expected to run one of its own before trusting a clean result.
 *
 * A hit reports WHERE and in WHICH ENCODING, never the value, so a failing
 * assertion prints nothing secret.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LeakHit {
  where: string;
  encoding: string;
}

/** The spellings of a secret worth looking for. */
export function encodingsOf(secret: string): { encoding: string; needle: string }[] {
  const out = [
    { encoding: "raw", needle: secret },
    { encoding: "base64", needle: Buffer.from(secret).toString("base64").replace(/=+$/, "") },
    { encoding: "json", needle: JSON.stringify(secret).slice(1, -1) },
    { encoding: "url", needle: encodeURIComponent(secret) },
  ];
  // Collapse encodings that are identical to raw for this value.
  return out.filter((e, i) => e.needle.length > 0 && out.findIndex((o) => o.needle === e.needle) === i);
}

export function scanText(where: string, text: string, secret: string): LeakHit[] {
  if (secret === "") throw new Error("scanText: refusing to scan for an empty secret");
  return encodingsOf(secret)
    .filter((e) => text.includes(e.needle))
    .map((e) => ({ where, encoding: e.encoding }));
}

export function scanTexts(sources: Record<string, string>, secret: string): LeakHit[] {
  return Object.entries(sources).flatMap(([where, text]) => scanText(where, text, secret));
}

export function scanEnv(where: string, env: Record<string, string | undefined>, secret: string): LeakHit[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value === undefined ? [] : scanText(`${where}:${name}`, `${name}=${value}`, secret),
  );
}

/** Every regular file under `dir`, recursively; symlinks are not followed. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Scan every file under `dir` except the sanctioned `exclude` paths. */
export function scanTree(dir: string, secret: string, options: { exclude?: string[] } = {}): LeakHit[] {
  const exclude = new Set(options.exclude ?? []);
  return listFiles(dir)
    .filter((p) => !exclude.has(p))
    .flatMap((p) => scanText(p, readFileSync(p, "latin1"), secret));
}

/** A random canary that cannot collide with anything real. */
export function canary(label = "canary"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `${label}_${Buffer.from(bytes).toString("hex")}`;
}
