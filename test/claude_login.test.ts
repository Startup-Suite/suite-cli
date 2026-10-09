/**
 * Claude Code's first-run screens: the theme picker (answered, it grants
 * nothing) and the login screens (recognised and reported, NEVER answered).
 *
 * Fixtures are real `tmux capture-pane -p` output from Claude Code 2.1.295 on
 * Linux at 80 and 120 columns, under a fresh HOME. In the login-URL screens the
 * `state` and `code_challenge` values were overwritten with `F`s of the same
 * length (so the wrapping is unchanged); nothing else was edited. The API-key
 * screen was captured with a fake key.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { classifyPane, dialogKeysArgv, type DialogIo } from "../src/claude_dialogs.ts";
import {
  classifyLogin,
  paneStatus,
  sessionStatusPath,
  writePaneStatus,
  type PaneStatus,
} from "../src/claude_login.ts";
import { parsePaneStatusArgs, runPaneStatus, type PaneStatusDeps } from "../src/commands/pane_status.ts";
import type { RunResult } from "../src/tmux.ts";

const DIR = resolve(import.meta.dir, "fixtures/claude-code-2.1.295-login");
const fixture = (name: string): string => readFileSync(resolve(DIR, `${name}.txt`), "utf8");
const OLD_DIR = resolve(import.meta.dir, "fixtures/claude-code-2.1.288-dialogs");
const oldFixture = (name: string): string => readFileSync(resolve(OLD_DIR, `${name}.txt`), "utf8");
const CTX = { cwd: "/srv/agents/work", home: "/home/agent" };
const NOW = new Date("2026-10-09T12:00:00.000Z");

describe("the theme picker is answered with Enter, and only the exact screen", () => {
  for (const width of ["120", "80"]) {
    test(`theme.${width} → Enter`, () => {
      expect(classifyPane(fixture(`theme.${width}`), CTX)).toEqual({ kind: "answer", dialog: "theme", keys: ["Enter"] });
    });
  }

  test("a reworded option is not answered", () => {
    const pane = fixture("theme.120").replace("Light mode (ANSI colors only)", "Light mode (ANSI only)");
    expect(classifyPane(pane, CTX).kind).not.toBe("answer");
  });

  test("two cursors are held, not answered", () => {
    const pane = fixture("theme.120").replace("     Light mode\n", " ❯ Light mode\n");
    expect(classifyPane(pane, CTX)).toEqual({ kind: "hold", dialog: "theme", reason: "no single cursor on a known option" });
  });

  test("the key is sent as a key name, to the exact session", () => {
    expect(dialogKeysArgv("suite-agent", ["Enter"])).toEqual(["tmux", "send-keys", "-t", "=suite-agent:", "Enter"]);
  });
});

describe("login screens are recognised", () => {
  for (const width of ["120", "80"]) {
    test(`login-method.${width}`, () => {
      expect(classifyLogin(fixture(`login-method.${width}`))).toEqual({ step: "login_method" });
    });

    test(`login-url.${width}: the URL is re-joined across Claude Code's own wrapping`, () => {
      const screen = classifyLogin(fixture(`login-url.${width}`));
      expect(screen?.step).toBe("login_url");
      const url = new URL(screen!.url!);
      expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")).toMatch(/^F+$/);
      expect(screen!.url).not.toMatch(/\s/);
    });
  }

  test("both widths yield the SAME url", () => {
    expect(classifyLogin(fixture("login-url.80"))!.url).toBe(classifyLogin(fixture("login-url.120"))!.url!);
  });

  test("api-key-confirm.120", () => {
    expect(classifyLogin(fixture("api-key-confirm.120"))).toEqual({ step: "api_key_confirm" });
  });
});

describe("login screens are NEVER answered by the dialog layer", () => {
  // The positive control is the theme test above: the same classifier DOES
  // answer a screen it owns. These must not come back as an answer.
  for (const name of ["login-method.120", "login-method.80", "login-url.120", "login-url.80", "api-key-confirm.120"]) {
    test(`${name} gets no keys`, () => {
      expect(classifyPane(fixture(name), CTX).kind).not.toBe("answer");
    });
  }
});

describe("non-login screens are not mistaken for one", () => {
  for (const name of ["ready.120", "trust-folder.120", "dev-channels.80", "bypass-permissions.120"]) {
    test(`${name} → null`, () => {
      expect(classifyLogin(oldFixture(name))).toBeNull();
    });
  }

  test("a URL from another host is not a login URL", () => {
    expect(classifyLogin(fixture("login-url.120").replace("https://claude.com/cai/", "https://evil.example/cai/"))).toBeNull();
  });

  test("a transcript that merely quotes the lead line, without the prompt, is not a login screen", () => {
    expect(classifyLogin("Browser didn't open? Use the url below to sign in (c to copy)\nhttps://claude.com/cai/oauth/authorize?x=1\n")).toBeNull();
  });
});

describe("paneStatus", () => {
  test("login → needs_login with the url", () => {
    const s = paneStatus("s", fixture("login-url.120"), CTX, NOW);
    expect(s.state).toBe("needs_login");
    expect(s.login?.step).toBe("login_url");
    expect(s.observed_at).toBe(NOW.toISOString());
  });
  test("ready", () => expect(paneStatus("s", oldFixture("ready.120"), CTX, NOW).state).toBe("ready"));
  test("known dialog", () => {
    expect(paneStatus("s", oldFixture("trust-folder.120"), CTX, NOW)).toMatchObject({ state: "dialog", dialog: "trust-folder" });
  });
  test("theme counts as a dialog", () => {
    expect(paneStatus("s", fixture("theme.80"), CTX, NOW)).toMatchObject({ state: "dialog", dialog: "theme" });
  });
  test("gone", () => expect(paneStatus("s", null, CTX, NOW).state).toBe("gone"));
  test("blank pane is starting", () => expect(paneStatus("s", "\n\n", CTX, NOW).state).toBe("starting"));
});

describe("the status file", () => {
  test("is written atomically at 0600 next to the session log", () => {
    const home = mkdtempSync(resolve(tmpdir(), "pane-status-"));
    const path = sessionStatusPath(home, "suite-agent");
    expect(path).toBe(`${home}/.local/state/suite/sessions/suite-agent.status.json`);
    const status = paneStatus("suite-agent", oldFixture("ready.120"), CTX, NOW);
    writePaneStatus(path, status);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(status);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("suite pane-status", () => {
  const harness = (pane: string | null) => {
    const sent: string[][] = [];
    const out: string[] = [];
    const written: PaneStatus[] = [];
    const run = async (argv: string[]): Promise<RunResult> => {
      sent.push(argv);
      if (argv[1] === "capture-pane") {
        return pane === null ? { exitCode: 1, stdout: "", stderr: "no session" } : { exitCode: 0, stdout: pane, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const tmux = { run, which: () => "tmux" } as unknown as PaneStatusDeps["tmux"];
    const dialogs: DialogIo = { tmux, now: () => 0, sleep: async () => {}, log: () => {} };
    const deps: PaneStatusDeps = {
      tmux,
      env: { HOME: "/home/agent" },
      cwd: "/srv/agents/work",
      now: () => NOW,
      out: (l) => out.push(l),
      err: () => {},
      write: (_p, s) => void written.push(s),
      dialogs,
    };
    return { deps, sent, out, written };
  };

  test("--session is required", () => {
    expect(parsePaneStatusArgs([])).toEqual({ error: "--session NAME is required" });
  });

  test("prints and writes one document", async () => {
    const h = harness(fixture("login-method.120"));
    expect(await runPaneStatus(h.deps, ["--session", "suite-agent"])).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ state: "needs_login", login: { step: "login_method" } });
    expect(h.written).toHaveLength(1);
    expect(h.sent.some((a) => a[1] === "send-keys")).toBe(false);
  });

  test("--answer answers the theme picker (positive control) ...", async () => {
    const h = harness(fixture("theme.120"));
    await runPaneStatus(h.deps, ["--session", "suite-agent", "--answer"]);
    expect(h.sent).toContainEqual(["tmux", "send-keys", "-t", "=suite-agent:", "Enter"]);
  });

  for (const name of ["login-method.120", "login-url.80", "api-key-confirm.120"]) {
    test(`... and sends NOTHING to ${name}`, async () => {
      const h = harness(fixture(name));
      await runPaneStatus(h.deps, ["--session", "suite-agent", "--answer"]);
      expect(h.sent.some((a) => a[1] === "send-keys")).toBe(false);
    });
  }

  test("a gone session exits 1", async () => {
    const h = harness(null);
    expect(await runPaneStatus(h.deps, ["--session", "suite-agent"])).toBe(1);
    expect(JSON.parse(h.out[0]!).state).toBe("gone");
  });
});
