import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * No deployment-specific access-proxy header may be named anywhere in this
 * repository — not as a default, not as a hint string, not as an example.
 *
 * Our own Suite instance happens to sit behind a particular access proxy and
 * needs a particular header pair. Another operator fronts theirs differently,
 * or not at all. Hardcoding ours would turn an accident of our infrastructure
 * into a property of the tool, and would quietly teach every reader that those
 * headers are what the CLI expects.
 *
 * The forbidden needles are assembled from fragments so that this test file
 * does not itself become the hit it is looking for.
 */
const NEEDLES = [["CF", "Access"].join("-"), ["cloud", "flare"].join("")];

const REPO = resolve(import.meta.dir, "..");

/** One neutral README sentence may say that header names are operator-specific. */
const README_ALLOWANCE = 1;

function trackedFiles(): string[] {
  // Cached AND untracked-but-not-ignored: a file added in this working tree and
  // not yet committed is exactly the one most likely to carry a paste.
  const p = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO,
    stdout: "pipe",
  });
  return new TextDecoder()
    .decode(p.stdout)
    .split("\0")
    .filter((f) => f !== "");
}

describe("no operator-specific access headers are hardcoded", () => {
  test("the tracked tree is free of them, case-insensitively", async () => {
    const files = trackedFiles();
    // Anti-vacuity: if the file list were empty this test would pass trivially.
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("src/secrets.ts");

    const hits: string[] = [];
    let readmeHits = 0;

    for (const file of files) {
      const text = await Bun.file(resolve(REPO, file)).text().catch(() => "");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? "").toLowerCase();
        if (!NEEDLES.some((n) => line.includes(n.toLowerCase()))) continue;
        if (file === "README.md") {
          readmeHits++;
          continue;
        }
        hits.push(`${file}:${i + 1}`);
      }
    }

    expect(hits).toEqual([]);
    expect(readmeHits).toBeLessThanOrEqual(README_ALLOWANCE);
  });

  test("the scan can actually find a hit, so a green result means something", async () => {
    const sample = `a line naming ${NEEDLES[0]}-Client-Id`.toLowerCase();
    expect(NEEDLES.some((n) => sample.includes(n.toLowerCase()))).toBe(true);
  });
});

/**
 * The documented minimum has to BE the minimum. This block exists because it
 * once was not: the README listed no prerequisites at all while the launcher
 * refused without `unzip`, so the only place the requirement was written down
 * was a failure message you reached by hitting the bug.
 *
 * WHY THESE ASSERTIONS ARE SHAPED THIS WAY. A grep of the whole README for the
 * substring "unzip" passes against *any* sentence mentioning unzip, including
 * one asserting the opposite ("unzip is not required"). So the tools are read
 * as LIST MEMBERSHIP: the prerequisites section is sliced out by heading, its
 * bullet items are parsed into names, and membership is asserted against that
 * parsed list. A sentence elsewhere in the file cannot satisfy it, and a
 * rewording that drops the item from the list fails.
 *
 * Likewise "does not claim Claude Code is a prerequisite" is a negative that
 * goes vacuous the moment the phrasing it refutes stops being used. So the
 * claim under test is the POSITIVE one that is actually true — Claude Code is
 * installed on demand at `suite claude`, declining exits non-zero, and logging
 * in stays the user's step — plus the non-membership of `claude` in the parsed
 * prerequisite list, which is a list operation and not a phrase match.
 */
const README = resolve(REPO, "README.md");

/** Text under `heading` up to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) throw new Error(`README has no heading ${JSON.stringify(heading)}`);
  const level = (heading.match(/^#+/) ?? ["#"])[0].length;
  const rest = lines.slice(start + 1);
  let end = rest.findIndex((l) => {
    const hashes = l.match(/^#{1,6} /);
    return hashes !== null && hashes[0].trim().length <= level;
  });
  if (end === -1) end = rest.length;
  return rest.slice(0, end).join("\n");
}

/** Collapse newlines/indent so a paragraph reflow cannot break a phrase check. */
function flat(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim();
}

/**
 * The prerequisite list proper: the body of "## Before you start" ABOVE its
 * first subsection. The Claude-on-demand subsection lives under that heading
 * and is explicitly not a prerequisite, so a bullet added there must not be
 * readable as one.
 */
function prerequisiteBody(markdown: string): string {
  return section(markdown, "## Before you start").split("\n### ")[0] as string;
}

/** Bullet items of the form "* `name` — ..." read as the list they render as. */
function bulletCodeItems(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((l) => l.match(/^\* +`([^`]+)`/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => (m[1] as string).trim());
}

describe("the README documents the real minimum", () => {
  test("the section slicer actually scopes, so membership means membership", async () => {
    const text = await Bun.file(README).text();
    const prereqs = prerequisiteBody(text);
    expect(prereqs.length).toBeGreaterThan(0);
    expect(prereqs.length).toBeLessThan(text.length);
    // It stops at the next same-level heading: nothing from later sections leaks in.
    expect(prereqs).not.toContain("## Install");
    expect(prereqs).not.toContain("MIT. See");
    // And it stops at the subsection, so a bullet there is not a prerequisite.
    expect(prereqs).not.toContain("Claude Code is not a prerequisite");
    // And it can find a hit it is meant to find.
    expect(bulletCodeItems("* `demo` — x\nnot a bullet\n")).toEqual(["demo"]);
  });

  test("unzip is an ITEM of the prerequisite list, not merely a word in the file", async () => {
    const text = await Bun.file(README).text();
    const tools = bulletCodeItems(prerequisiteBody(text));
    // Anti-vacuity: an empty or unparsed list must not satisfy the membership check.
    expect(tools.length).toBeGreaterThanOrEqual(5);
    expect(tools).toContain("git");
    expect(tools).toContain("curl");
    expect(tools).toContain("ca-certificates");
    expect(tools).toContain("tar");
    expect(tools).toContain("unzip");
  });

  test("the unzip entry says suite checks for it and does not install it", async () => {
    const text = await Bun.file(README).text();
    const prereqs = prerequisiteBody(text);
    const entry = prereqs.split("\n* ").find((item) => item.startsWith("`unzip`"));
    expect(entry).toBeDefined();
    // The requirement belongs to bun's own installer, and we never install it.
    const unzipEntry = flat(entry as string);
    expect(unzipEntry).toContain("bun");
    expect(/checks for/i.test(unzipEntry)).toBe(true);
    expect(/will not install it/i.test(unzipEntry)).toBe(true);
  });

  test("Claude Code is documented as installed on demand, and login stays the user's step", async () => {
    const text = await Bun.file(README).text();
    // Non-membership as a LIST operation: claude is not one of the prerequisites.
    const tools = bulletCodeItems(prerequisiteBody(text));
    expect(tools).not.toContain("claude");
    expect(tools).not.toContain("claude-code");

    // Phrase checks run on whitespace-normalised text: a paragraph reflow moves
    // a line break into the middle of a phrase and would otherwise "fail" a
    // claim the README still makes (or, inverted, make a refutation vacuous).
    const onDemand = flat(section(text, "### Claude Code is installed on demand, not up front"));
    // The positive claims, each of which the code actually implements.
    expect(onDemand).toContain("suite claude");
    expect(onDemand).toContain("offers to install it");
    expect(onDemand).toContain("exits non-zero");
    expect(/logging in is still your step/i.test(onDemand)).toBe(true);
  });

  test("the cold-start caveat admits the scratch HOME cannot prove absence", async () => {
    const text = await Bun.file(README).text();
    const caveats = flat(section(text, "### What the tests do not prove"));
    expect(caveats).toContain("unzip");
    expect(caveats).toContain("claude");
    expect(/only a container/i.test(caveats)).toBe(true);
  });
});
