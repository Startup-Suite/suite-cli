/**
 * `suite harness --json` and `suite harness install`.
 *
 * Injected filesystem and runner: no real binary is probed, nothing installs,
 * and the PATH searched is exactly the one in the injected env.
 */
import { describe, expect, test } from "bun:test";
import {
  harnessDocument,
  HARNESS_KINDS,
  parseHarnessArgs,
  pathLine,
  parseVersion,
  runHarness,
  runHarnessInstall,
  whichOn,
  type HarnessDeps,
  type RunOutcome,
} from "../src/commands/harness.ts";

const HOME = "/Users/agent01a0d6b9";

function deps(opts: {
  exe: string[];
  dirs?: string[];
  path?: string;
  platform?: string;
  responses?: Record<string, Partial<RunOutcome>>;
}) {
  const ran: { argv: string[]; env: Record<string, string> }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: HarnessDeps = {
    env: { HOME, PATH: opts.path ?? "/usr/bin:/bin", SUITE_TOKEN: "tok-must-not-reach-a-child" },
    platform: opts.platform ?? "darwin",
    cwd: `${HOME}/agent`,
    run: async (argv, o) => {
      ran.push({ argv, env: o.env });
      const key = argv.slice(1).join(" ");
      const r = opts.responses?.[`${argv[0]} ${key}`] ?? opts.responses?.[key] ?? {};
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r };
    },
    isExecutable: (p) => opts.exe.includes(p),
    isDirectory: (p) => (opts.dirs ?? []).includes(p),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
  };
  return { d, ran, out, err };
}

const row = async (d: HarnessDeps, kind: string, root = `${HOME}/agent`) =>
  (await harnessDocument(d, root)).harnesses.find((r) => r.kind === kind)!;

describe("suite harness --json", () => {
  test("one row per kind, in a fixed order", async () => {
    const t = deps({ exe: [] });
    const doc = await harnessDocument(t.d, `${HOME}/agent`);
    expect(doc.contract_version).toBe(1);
    expect(doc.harnesses.map((r) => r.kind)).toEqual([...HARNESS_KINDS]);
  });

  test("MISSING: claude absent everywhere → found false, no probe run, install mode auto", async () => {
    const t = deps({ exe: [] });
    const r = await row(t.d, "claude");
    expect(r).toMatchObject({ found: false, found_off_path: false, path: null, path_line: null, version: null, logged_in: "unknown", suite_ready: false });
    expect(r.install).toEqual({ mode: "auto", command: "curl -fsSL https://claude.ai/install.sh | bash", url: "https://code.claude.com/docs/en/setup" });
    expect(t.ran).toEqual([]);
  });

  test("FOUND_OFF_PATH: ~/.local/bin/claude exists but PATH lacks it → found false, found_off_path, the exact PATH line", async () => {
    const t = deps({
      exe: [`${HOME}/.local/bin/claude`],
      responses: { "--version": { stdout: "2.1.289 (Claude Code)\n" }, "auth status --json": { exitCode: 1, stdout: '{"loggedIn": false, "authMethod": "none"}' } },
    });
    const r = await row(t.d, "claude");
    expect(r.found).toBe(false);
    expect(r.found_off_path).toBe(true);
    expect(r.path).toBe(`${HOME}/.local/bin/claude`);
    expect(r.path_line).toBe(`export PATH="${HOME}/.local/bin:$PATH"`);
    expect(r.version).toBe("2.1.289");
    expect(r.logged_in).toBe(false);
    expect(r.suite_ready).toBe(false);
  });

  test("FOUND (positive control): on PATH and logged in → suite_ready", async () => {
    const t = deps({
      exe: ["/opt/homebrew/bin/claude"],
      path: "/opt/homebrew/bin:/usr/bin",
      responses: { "--version": { stdout: "2.1.289 (Claude Code)\n" }, "auth status --json": { stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' } },
    });
    const r = await row(t.d, "claude");
    expect(r).toMatchObject({ found: true, found_off_path: false, path: "/opt/homebrew/bin/claude", path_line: null, logged_in: true, suite_ready: true });
  });

  test("only the GIVEN PATH is searched: the same binary in a directory not on it is not 'found'", () => {
    const exe = ["/opt/homebrew/bin/codex"];
    expect(whichOn("codex", "/usr/bin:/bin", (p) => exe.includes(p))).toBeNull();
    expect(whichOn("codex", "/usr/bin:/opt/homebrew/bin", (p) => exe.includes(p))).toBe("/opt/homebrew/bin/codex");
    expect(whichOn("codex", "", (p) => exe.includes(p))).toBeNull();
  });

  test("codex: login status runs with CODEX_HOME=<root>/.codex, and a missing home is logged out without asking", async () => {
    const root = `${HOME}/SuiteAgents/quasar`;
    const t = deps({ exe: ["/usr/local/bin/codex"], path: "/usr/local/bin", dirs: [`${root}/.codex`], responses: { "login status": { exitCode: 1, stderr: "Not logged in\n" } } });
    const r = await row(t.d, "codex", root);
    expect(r.logged_in).toBe(false);
    const status = t.ran.find((x) => x.argv[1] === "login")!;
    expect(status.env.CODEX_HOME).toBe(`${root}/.codex`);

    const none = deps({ exe: ["/usr/local/bin/codex"], path: "/usr/local/bin" });
    const r2 = await row(none.d, "codex", root);
    expect(r2.logged_in).toBe(false);
    expect(none.ran.some((x) => x.argv[1] === "login")).toBe(false);
    expect(r2.install).toEqual({ mode: "command", command: "npm install -g @openai/codex", url: "https://github.com/openai/codex" });
  });

  test("no probe child receives a SUITE_* variable", async () => {
    const t = deps({ exe: ["/usr/bin/claude", "/usr/bin/codex"], dirs: [`${HOME}/agent/.codex`] });
    await harnessDocument(t.d, `${HOME}/agent`);
    expect(t.ran.length).toBeGreaterThan(0);
    for (const r of t.ran) expect(Object.keys(r.env).filter((k) => k.startsWith("SUITE_"))).toEqual([]);
  });

  test("openclaw / hermes / deepseek: logged_in unknown, a `suite <verb>` command, never actionable here", async () => {
    const t = deps({ exe: ["/usr/bin/hermes"] });
    const doc = await harnessDocument(t.d, `${HOME}/agent`);
    const h = doc.harnesses.find((r) => r.kind === "hermes")!;
    expect(h).toMatchObject({ found: true, logged_in: "unknown", suite_ready: true });
    expect(h.install.command).toBe("suite hermes --root DIR");
    expect(doc.harnesses.find((r) => r.kind === "deepseek")!.install.command).toBe("suite deepseek");
  });

  test("helpers", () => {
    expect(pathLine("/a/b/claude")).toBe('export PATH="/a/b:$PATH"');
    expect(parseVersion("codex-cli 0.157.0\n")).toBe("0.157.0");
    expect(parseVersion("")).toBeNull();
    expect(parseHarnessArgs(["install", "claude", "--yes", "--json"])).toEqual({ json: true, install: "claude", yes: true });
    expect(parseHarnessArgs(["--json", "--root", "/r"])).toEqual({ json: true, root: "/r", yes: false });
    expect(parseHarnessArgs(["--bogus"]).error).toContain("unknown option");
  });

  test("runHarness --json prints exactly one JSON document on stdout", async () => {
    const t = deps({ exe: [] });
    expect(await runHarness(["--json"], t.d)).toBe(0);
    expect(t.out.length).toBe(1);
    expect(JSON.parse(t.out[0]!).harnesses.length).toBe(5);
  });
});

describe("suite harness install", () => {
  const tools = ["/usr/bin/curl", "/usr/bin/bash"];

  test("claude --yes runs the official installer with no prompt and re-detects; installer output goes to stderr", async () => {
    let installed = false;
    const t = deps({ exe: tools });
    const baseRun = t.d.run;
    t.d.run = async (argv, o) => {
      if (argv[0] === "sh") installed = true;
      const r = await baseRun(argv, o);
      return argv[0] === "sh" ? { ...r, stdout: "Claude Code successfully installed!\n" } : r;
    };
    t.d.isExecutable = (p) => tools.includes(p) || (installed && p === `${HOME}/.local/bin/claude`);
    const { code, doc } = await runHarnessInstall(t.d, "claude", { yes: true, root: `${HOME}/agent` });
    expect(code).toBe(0);
    expect(t.ran[0]!.argv).toEqual(["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
    expect(Object.keys(t.ran[0]!.env).filter((k) => k.startsWith("SUITE_"))).toEqual([]);
    expect(doc).toMatchObject({ ok: true, kind: "claude", ran_installer: true, human_steps: [], error: null });
    // ~/.local/bin is not on the given PATH: honest about it.
    expect(doc.harness).toMatchObject({ found: false, found_off_path: true, path_line: `export PATH="${HOME}/.local/bin:$PATH"` });
    expect(t.err.join("")).toContain("successfully installed");
  });

  test("claude without --yes: refused with exit 2, nothing run", async () => {
    const t = deps({ exe: tools });
    const { code, doc } = await runHarnessInstall(t.d, "claude", { yes: false, root: "/r" });
    expect(code).toBe(2);
    expect(doc.error?.code).toBe("confirmation_required");
    expect(t.ran).toEqual([]);
  });

  test("claude with curl missing: exit 1 installer_tools_missing, nothing run", async () => {
    const t = deps({ exe: ["/usr/bin/bash"] });
    const { code, doc } = await runHarnessInstall(t.d, "claude", { yes: true, root: "/r" });
    expect(code).toBe(1);
    expect(doc.error?.code).toBe("installer_tools_missing");
    expect(t.ran).toEqual([]);
  });

  test("a failing installer is a failure, not a success", async () => {
    const t = deps({ exe: tools, responses: { "sh -c curl -fsSL https://claude.ai/install.sh | bash": { exitCode: 22 } } });
    const { code, doc } = await runHarnessInstall(t.d, "claude", { yes: true, root: "/r" });
    expect(code).toBe(1);
    expect(doc.error?.code).toBe("installer_failed");
  });

  for (const kind of ["codex", "openclaw", "hermes", "deepseek"]) {
    test(`${kind}: NO package manager runs — a human step with the official command, exit 3`, async () => {
      const t = deps({ exe: ["/usr/bin/npm", ...tools] });
      const { code, doc } = await runHarnessInstall(t.d, kind, { yes: true, root: "/r" });
      expect(code).toBe(3);
      expect(doc.human_steps.length).toBe(1);
      expect(doc.human_steps[0]).toMatchObject({ kind: "install_harness", harness: kind });
      expect(doc.ran_installer).toBe(false);
      // Not even a probe of a package manager: nothing ran except --version probes of a found binary (none here).
      expect(t.ran.filter((r) => /npm|brew|pip|sh$/.test(r.argv[0]!))).toEqual([]);
    });
  }

  test("codex's human step is the vendor's npm command and page", async () => {
    const t = deps({ exe: [] });
    const { doc } = await runHarnessInstall(t.d, "codex", { yes: true, root: "/r" });
    expect(doc.human_steps[0]).toEqual({ kind: "install_harness", harness: "codex", command: "npm install -g @openai/codex", url: "https://github.com/openai/codex" });
  });

  test("an unknown harness is refused", async () => {
    const t = deps({ exe: [] });
    expect((await runHarnessInstall(t.d, "vim", { yes: true, root: "/r" })).code).toBe(2);
  });
});
