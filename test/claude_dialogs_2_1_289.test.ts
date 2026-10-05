/**
 * Re-check of the 0.6.1 dialog answerer against Claude Code 2.1.289.
 *
 * The fixtures are real `tmux capture-pane -p` output from Claude Code 2.1.289
 * on rock (macOS 26.3, 2026-10-05), captured at 80 and 120 columns on a
 * private tmux socket under an isolated, NOT-logged-in HOME (no login was ever
 * completed there). Nothing was edited; the folder is the capture folder.
 *
 * WHAT 2.1.289 DID AND DID NOT SHOW, measured:
 *  - trust-folder and bypass-permissions: shown, and word for word the 2.1.288
 *    text — the answerer gives the same keys.
 *  - dev-channels: NOT shown. Logged out, 2.1.289 prints
 *    "--dangerously-load-development-channels ignored (server:suite-channel)
 *    / Channels are not currently available" and skips the warning, so this
 *    capture cannot re-check that dialog's wording. Its 2.1.288 fixture stays
 *    the reference until a logged-in capture exists (reported as a finding).
 *  - mcp-server: not raised (as on 2.1.288 with --dangerously-skip-permissions).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyPane } from "../src/claude_dialogs.ts";

const DIR = resolve(import.meta.dir, "fixtures/claude-code-2.1.289-dialogs");
const fixture = (name: string): string => readFileSync(resolve(DIR, `${name}.txt`), "utf8");
const ctx = (w: number) => ({ cwd: `/private/tmp/suite-01a0d6b9-s2/dhome-${w}/agent-01a0d6b9`, home: `/private/tmp/suite-01a0d6b9-s2/dhome-${w}` });

describe("Claude Code 2.1.289: the recorded dialogs get exactly the 2.1.288 keys", () => {
  for (const w of [80, 120]) {
    const cases: [string, string, string[]][] = [
      [`trust-folder.${w}`, "trust-folder", ["Down"]],
      [`trust-folder.${w}.cursor-yes`, "trust-folder", ["Enter"]],
      [`bypass-permissions.${w}`, "bypass-permissions", ["Down"]],
      [`bypass-permissions.${w}.cursor-yes`, "bypass-permissions", ["Enter"]],
    ];
    for (const [file, dialog, keys] of cases) {
      test(`${file} → ${dialog}: ${keys.join(" ")}`, () => {
        expect(classifyPane(fixture(file), ctx(w))).toEqual({ kind: "answer", dialog: dialog as never, keys });
      });
    }

    test(`ready-not-logged-in.${w}: the 2.1.289 input box reads as ready`, () => {
      expect(classifyPane(fixture(`ready-not-logged-in.${w}`), ctx(w))).toEqual({ kind: "ready" });
    });

    test(`trust-folder.${w} naming another folder is held, not answered`, () => {
      expect(classifyPane(fixture(`trust-folder.${w}`), { cwd: "/srv/other", home: "/srv" })).toMatchObject({ kind: "hold", dialog: "trust-folder" });
    });
  }

  test("a 2.1.289 dialog with one word changed gets no keys (the check can fail)", () => {
    const pane = fixture("bypass-permissions.80").replace("restricted internet access", "limited internet access");
    expect(classifyPane(pane, ctx(80)).kind).not.toBe("answer");
  });
});
