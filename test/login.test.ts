/**
 * `suite login` and the shared login classifier (src/login.ts).
 *
 * The classifier is checked against REAL harness output captured on rock
 * (macOS 26.3, 2026-10-05) under an isolated HOME and CODEX_HOME, never
 * completing a login: Claude Code 2.1.289 and codex-cli 0.157.0. Only the
 * OAuth `state` / `code_challenge` values and Codex's one-time code were
 * replaced (FIXTURE_REDACTED, TEST-01A0D); nothing else was edited. See
 * test/fixtures/harness-login/.
 *
 * The leak tests run the REAL `suite login` as a subprocess against stub
 * harnesses that record their argv, env and stdin, with a planted marker on
 * suite's own stdin. A paste code must never reach the harness, an argv, a
 * log or a file — and suite has no paste path at all (the Claude Code legal
 * line quoted in src/commands/login.ts), so the marker must reach nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  browserUrlFromShim,
  classifyClaudeAuthStatus,
  classifyClaudeLoginOutput,
  classifyCodexLoginStatus,
  isLocalhostCallback,
  parseCodexDeviceAuth,
  stripAnsi,
} from "../src/login.ts";
import { parseLoginArgs, runLogin, type BrowserShim, type LoginDeps, type LoginProcess } from "../src/commands/login.ts";

const FIX = resolve(import.meta.dir, "fixtures/harness-login");
const fx = (name: string): string => readFileSync(join(FIX, name), "utf8");
const CLI = resolve(import.meta.dir, "../src/cli.ts");

const scratch: string[] = [];
const temp = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `suite-login-test-${label}-`));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("the classifier reads the real 2.1.289 / 0.157.0 output", () => {
  test("claude auth status --json, logged out (exit 1, document still printed)", () => {
    expect(classifyClaudeAuthStatus(fx("claude-2.1.289-auth-status.logged-out.json"), 1)).toEqual({ logged_in: false, method: "none" });
  });

  test("claude auth status --json, logged in", () => {
    const doc = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    expect(classifyClaudeAuthStatus(doc, 0)).toEqual({ logged_in: true, method: "claude.ai" });
  });

  test("no JSON at all is unknown, never logged out", () => {
    expect(classifyClaudeAuthStatus("", 1).logged_in).toBe("unknown");
    expect(classifyClaudeAuthStatus("error: unknown command auth", 2).logged_in).toBe("unknown");
    expect(classifyClaudeAuthStatus('{"loggedIn": "maybe"}', 0).logged_in).toBe("unknown");
  });

  test("codex login status: 'Not logged in' + exit 1 is logged out; exit 0 logged in; a config error is unknown", () => {
    expect(classifyCodexLoginStatus(1, "", fx("codex-0.157.0-login-status.logged-out.stderr.txt"))).toBe(false);
    expect(classifyCodexLoginStatus(0, "Logged in using ChatGPT\n", "")).toBe(true);
    const missingHome =
      'Error loading configuration: CODEX_HOME points to "/x/.codex", but that path does not exist\n';
    expect(classifyCodexLoginStatus(1, "", missingHome)).toBe("unknown");
  });

  test("the browser URL is the LOCALHOST-callback one; the printed fallback URL is a paste-code flow and is not", () => {
    const browser = fx("claude-2.1.289-auth-login.browser-argv.txt");
    const printed = fx("claude-2.1.289-auth-login.stdout.txt");
    const url = browserUrlFromShim(browser);
    expect(url).not.toBeNull();
    expect(isLocalhostCallback(url!)).toBe(true);
    expect(new URL(new URL(url!).searchParams.get("redirect_uri")!).hostname).toBe("localhost");
    // The fallback printed on stdout redirects to platform.claude.com: a pasted code.
    const fallback = /https:\/\/\S+/.exec(printed)![0];
    expect(isLocalhostCallback(fallback)).toBe(false);
    expect(browserUrlFromShim(printed)).toBeNull();
    // Even handed to $BROWSER, a paste-code URL is never surfaced (mutation M13 found this unasserted).
    expect(browserUrlFromShim(`${fallback}\n`)).toBeNull();
    expect(classifyClaudeLoginOutput(printed)).toEqual({ pasteFallbackOffered: true, openingBrowser: true });
  });

  test("the codex device-code screen yields url, code and expiry (ANSI stripped)", () => {
    const out = fx("codex-0.157.0-login-device-auth.stdout.txt");
    expect(out).toContain("\x1b[");
    expect(parseCodexDeviceAuth(out)).toEqual({ url: "https://auth.openai.com/codex/device", code: "TEST-01A0D", expiresInMinutes: 15 });
    expect(stripAnsi(out)).not.toContain("\x1b[");
  });

  test("a partial device screen is not a device code yet", () => {
    const out = fx("codex-0.157.0-login-device-auth.stdout.txt");
    expect(parseCodexDeviceAuth(out.slice(0, out.indexOf("2. Enter")))).toBeNull();
  });
});

describe("parseLoginArgs", () => {
  test("kinds and flags", () => {
    expect(parseLoginArgs(["claude", "--json", "--no-browser"])).toEqual({ kind: "claude", json: true, noBrowser: true });
    expect(parseLoginArgs(["codex", "--root", "/a/b", "--json"])).toEqual({ kind: "codex", root: "/a/b", json: true, noBrowser: false });
    expect("error" in parseLoginArgs(["openclaw"])).toBe(true);
    expect("error" in parseLoginArgs(["claude", "--paste-code", "x"])).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* runLogin with injected deps: the timing branches                           */
/* ------------------------------------------------------------------------- */

function fakeDeps(opts: {
  statuses: string[];
  shimUrlAfterMs?: number;
  exitAfterMs?: number;
  exitCode?: number;
  stdoutChunks?: string[];
}) {
  let clock = 0;
  const out: string[] = [];
  const err: string[] = [];
  const spawned: { argv: string[]; env: Record<string, string> }[] = [];
  const statuses = [...opts.statuses];
  let killed = false;
  let shimText = "";
  const url = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5123%2Fcallback&state=S";
  const deps: LoginDeps = {
    env: { HOME: "/home/a", PATH: "/bin" },
    cwd: "/home/a/agent",
    spawn(argv, o) {
      spawned.push({ argv, env: o.env });
      let resolveExit: (c: number) => void = () => {};
      const exited = new Promise<number>((r) => (resolveExit = r));
      const listeners: ((c: string) => void)[] = [];
      const p: LoginProcess = {
        onStdout: (cb) => {
          listeners.push(cb);
          for (const c of opts.stdoutChunks ?? []) cb(c);
        },
        exited,
        kill: () => {
          killed = true;
          resolveExit(143);
        },
      };
      const tick = setInterval(() => {
        if (opts.shimUrlAfterMs !== undefined && clock >= opts.shimUrlAfterMs) shimText = `${url}\n`;
        if (opts.exitAfterMs !== undefined && clock >= opts.exitAfterMs) {
          clearInterval(tick);
          resolveExit(opts.exitCode ?? 0);
        }
      }, 1);
      void exited.then(() => clearInterval(tick));
      return p;
    },
    run: async () => {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return { exitCode: s.includes('"loggedIn": true') || s === "codex-in" ? 0 : 1, stdout: s === "codex-in" ? "" : s, stderr: s === "codex-out" ? "Not logged in\n" : "", timedOut: false };
    },
    isExecutable: (p) => p === "/bin/claude" || p === "/bin/codex",
    ensureDir: () => {},
    browserShim: (): BrowserShim => ({ path: "/tmp/shim/browser", read: () => shimText, cleanup: () => {} }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 2));
    },
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    timeouts: { loginMs: 60_000, browserWaitMs: 5_000, pollMs: 250 },
  };
  const events = () => out.join("").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { deps, out, err, spawned, events, wasKilled: () => killed };
}

const OUT = '{"loggedIn": false, "authMethod": "none"}';
const IN = '{"loggedIn": true, "authMethod": "claude.ai"}';

describe("suite login claude (injected deps)", () => {
  test("already logged in: done true, no login spawned", async () => {
    const t = fakeDeps({ statuses: [IN] });
    expect(await runLogin(["claude", "--json", "--no-browser"], t.deps)).toBe(0);
    expect(t.events()).toEqual([{ event: "done", logged_in: true }]);
    expect(t.spawned).toEqual([]);
  });

  test("localhost flow: BROWSER is the shim, open_url is the localhost URL, done true", async () => {
    const t = fakeDeps({ statuses: [OUT, IN], shimUrlAfterMs: 500, exitAfterMs: 2_000 });
    expect(await runLogin(["claude", "--json", "--no-browser"], t.deps)).toBe(0);
    expect(t.spawned[0]!.argv).toEqual(["/bin/claude", "auth", "login", "--claudeai"]);
    expect(t.spawned[0]!.env.BROWSER).toBe("/tmp/shim/browser");
    const ev = t.events();
    expect(ev[0]!.event).toBe("open_url");
    expect(isLocalhostCallback(String(ev[0]!.url))).toBe(true);
    expect(ev.at(-1)).toEqual({ event: "done", logged_in: true });
    expect(ev.some((e) => e.event === "paste_code_needed")).toBe(false);
  });

  test("no localhost URL within the wait: human_step complete_login_in_terminal, exit 3, the harness is killed", async () => {
    const t = fakeDeps({ statuses: [OUT, OUT] });
    expect(await runLogin(["claude", "--json", "--no-browser"], t.deps)).toBe(3);
    const ev = t.events();
    expect(ev[0]).toEqual({ event: "human_step", kind: "complete_login_in_terminal", command: "claude auth login --claudeai", reason: "no_localhost_callback" });
    expect(ev.at(-1)).toEqual({ event: "done", logged_in: false });
    expect(t.wasKilled()).toBe(true);
  });

  test("the URL opened but the login never finished: login_timeout, exit 1", async () => {
    const t = fakeDeps({ statuses: [OUT, OUT], shimUrlAfterMs: 100 });
    expect(await runLogin(["claude", "--json", "--no-browser"], t.deps)).toBe(1);
    expect(t.events().map((e) => e.event)).toEqual(["open_url", "error", "done"]);
  });

  test("claude exits without a login: human_step, never a paste prompt of ours", async () => {
    const t = fakeDeps({ statuses: [OUT, OUT], shimUrlAfterMs: 100, exitAfterMs: 1_000, exitCode: 1 });
    expect(await runLogin(["claude", "--json", "--no-browser"], t.deps)).toBe(3);
    expect(t.events().map((e) => e.event)).toEqual(["open_url", "human_step", "done"]);
  });

  test("claude not on PATH: error + done false, exit 4", async () => {
    const t = fakeDeps({ statuses: [OUT] });
    t.deps.isExecutable = () => false;
    expect(await runLogin(["claude", "--json"], t.deps)).toBe(4);
    expect(t.events().map((e) => e.event)).toEqual(["error", "done"]);
  });
});

describe("suite login codex (injected deps)", () => {
  test("device code then open_url, then done true; CODEX_HOME is <root>/.codex", async () => {
    const t = fakeDeps({ statuses: ["codex-out", "codex-in"], exitAfterMs: 1_000, stdoutChunks: [fx("codex-0.157.0-login-device-auth.stdout.txt")] });
    expect(await runLogin(["codex", "--root", "/srv/agent-01a0d6b9", "--json", "--no-browser"], t.deps)).toBe(0);
    expect(t.spawned[0]!.argv).toEqual(["/bin/codex", "login", "--device-auth"]);
    expect(t.spawned[0]!.env.CODEX_HOME).toBe("/srv/agent-01a0d6b9/.codex");
    const ev = t.events();
    expect(ev[0]).toMatchObject({ event: "device_code", code: "TEST-01A0D", url: "https://auth.openai.com/codex/device" });
    expect(Date.parse(String(ev[0]!.expires_at))).toBe(15 * 60_000);
    expect(ev[1]).toEqual({ event: "open_url", url: "https://auth.openai.com/codex/device" });
    expect(ev.at(-1)).toEqual({ event: "done", logged_in: true });
    // The code is shown once, on stdout, and never on stderr.
    expect(t.out.join("").split("TEST-01A0D").length - 1).toBe(1);
    expect(t.err.join("")).not.toContain("TEST-01A0D");
  });
});

/* ------------------------------------------------------------------------- */
/* The real verb, as a subprocess, against recording stub harnesses           */
/* ------------------------------------------------------------------------- */

const MARKER = "PASTE-CODE-01a0d6b9-MARKER";
const DEVICE = "QZXW-01A0D";

/** A stub `claude`: auth status from a flag file; auth login records argv/env/stdin, calls $BROWSER, logs in. */
function stubClaude(bin: string, rec: string): void {
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
REC='${rec}'
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -f "$HOME/.stub-logged-in" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0; fi
  echo '{"loggedIn": false, "authMethod": "none"}'; exit 1
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  printf '%s\\n' "$@" > "$REC/argv"
  env > "$REC/env"
  # Whatever reaches our stdin within 1 s is recorded: a paste code must not.
  exec 3<&0; ( cat <&3 > "$REC/stdin" ) & CAT=$!; sleep 1; kill $CAT 2>/dev/null
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=S"
  printf 'Paste code here if prompted > '
  "$BROWSER" "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A50731%2Fcallback&state=S"
  sleep 1
  touch "$HOME/.stub-logged-in"
  exit 0
fi
exit 2
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
}

function stubCodex(bin: string, rec: string): void {
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
REC='${rec}'
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  if [ -f "$CODEX_HOME/stub-auth" ]; then echo "Logged in using ChatGPT"; exit 0; fi
  echo "Not logged in" >&2; exit 1
fi
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  printf '%s\\n' "$@" > "$REC/argv"
  env > "$REC/env"
  exec 3<&0; ( cat <&3 > "$REC/stdin" ) & CAT=$!; sleep 1; kill $CAT 2>/dev/null
  printf '\\nFollow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n\\n2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94m${DEVICE}\\033[0m\\n\\n'
  sleep 1
  touch "$CODEX_HOME/stub-auth"
  exit 0
fi
exit 2
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesUnder(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

async function runVerb(args: string[], home: string, bin: string, tmp: string) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: home,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp, LANG: "C" },
    stdin: new TextEncoder().encode(`${MARKER}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("LEAK: the real suite login never relays a paste code, and shows a device code only on stdout", () => {
  test("planted-marker positive control: the stub DOES record stdin it is given", async () => {
    const root = temp("ctl");
    const bin = join(root, "bin");
    const rec = join(root, "rec");
    mkdirSync(bin);
    mkdirSync(rec);
    stubClaude(bin, rec);
    // Run the stub directly with the marker on its stdin: the recorder must catch it.
    const p = Bun.spawn([join(bin, "claude"), "auth", "login", "--claudeai"], {
      env: { HOME: root, PATH: "/usr/bin:/bin", BROWSER: "/usr/bin/true" },
      stdin: new TextEncoder().encode(`${MARKER}\n`),
      stdout: "ignore",
    });
    await p.exited;
    expect(readFileSync(join(rec, "stdin"), "utf8")).toContain(MARKER);
  });

  test("claude: open_url is the localhost URL; the marker reaches no argv, env, stdin, output or file", async () => {
    const root = temp("claude");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const rec = join(root, "rec");
    const tmp = join(home, "tmp");
    for (const d of [home, bin, rec, tmp]) mkdirSync(d, { recursive: true });
    stubClaude(bin, rec);
    const r = await runVerb(["login", "claude", "--json", "--no-browser"], home, bin, tmp);
    expect(r.code).toBe(0);
    const events = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]!.event).toBe("open_url");
    expect(String(events[0]!.url)).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A50731%2Fcallback");
    expect(events.at(-1)).toEqual({ event: "done", logged_in: true });
    expect(events.some((e) => e.event === "paste_code_needed")).toBe(false);
    // The harness got stdin from /dev/null, its own BROWSER shim, and nothing of ours.
    expect(readFileSync(join(rec, "stdin"), "utf8")).toBe("");
    expect(readFileSync(join(rec, "argv"), "utf8")).toBe("auth\nlogin\n--claudeai\n");
    const env = readFileSync(join(rec, "env"), "utf8");
    expect(env).toMatch(/^BROWSER=.*\/suite-login-[^/]+\/browser$/m);
    const corpus = [r.stdout, r.stderr, env, readFileSync(join(rec, "argv"), "utf8"), ...filesUnder(root).map((f) => readFileSync(f, "utf8"))].join("\n");
    expect(corpus).not.toContain(MARKER);
    // stderr carries no URL at all; the shim directory is gone.
    expect(r.stderr).not.toContain("https://");
    expect(readdirSync(tmp).filter((n) => n.startsWith("suite-login-"))).toEqual([]);
  }, 20_000);

  test("a cancelled login (SIGTERM) removes the browser shim directory and stops the harness", async () => {
    const root = temp("cancel");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const rec = join(root, "rec");
    const tmp = join(home, "tmp");
    for (const d of [home, bin, rec, tmp]) mkdirSync(d, { recursive: true });
    // A claude that hands $BROWSER its URL and then waits for a callback that never comes.
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
if [ "$2" = "status" ]; then echo '{"loggedIn": false}'; exit 1; fi
echo $$ > '${rec}/pid'
"$BROWSER" "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A50999%2Fcallback&state=S"
exec sleep 60
`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    const proc = Bun.spawn([process.execPath, CLI, "login", "claude", "--json", "--no-browser"], {
      cwd: home,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp, LANG: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let seen = "";
    while (!seen.includes("open_url")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain("open_url");
    // Positive control: while it runs, the shim directory exists.
    expect(readdirSync(tmp).filter((n) => n.startsWith("suite-login-")).length).toBe(1);
    proc.kill("SIGTERM");
    await proc.exited;
    expect(readdirSync(tmp).filter((n) => n.startsWith("suite-login-"))).toEqual([]);
    const pid = Number(readFileSync(join(rec, "pid"), "utf8"));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(100);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 20_000);

  test("codex: the device code appears once, in the stdout event, and nowhere else", async () => {
    const root = temp("codex");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const rec = join(root, "rec");
    const tmp = join(home, "tmp");
    const agent = join(home, "agent-01a0d6b9");
    for (const d of [home, bin, rec, tmp, agent]) mkdirSync(d, { recursive: true });
    stubCodex(bin, rec);
    const r = await runVerb(["login", "codex", "--root", agent, "--json", "--no-browser"], home, bin, tmp);
    expect(r.code).toBe(0);
    const events = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.event)).toEqual(["device_code", "open_url", "done"]);
    expect(events[0]).toMatchObject({ code: DEVICE, url: "https://auth.openai.com/codex/device" });
    expect(readFileSync(join(rec, "env"), "utf8")).toContain(`CODEX_HOME=${join(agent, ".codex")}`);
    expect(statSync(join(agent, ".codex")).mode & 0o777).toBe(0o700);
    expect(r.stdout.split(DEVICE).length - 1).toBe(1);
    expect(r.stderr).not.toContain(DEVICE);
    // No file anywhere but the stub itself (bin/) carries the code or the marker.
    for (const f of filesUnder(root).filter((p) => !p.startsWith(`${bin}/`))) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain(DEVICE);
      expect(text).not.toContain(MARKER);
    }
    expect(readFileSync(join(rec, "stdin"), "utf8")).toBe("");
    expect(existsSync(join(agent, ".codex", "stub-auth"))).toBe(true);
  }, 20_000);
});
