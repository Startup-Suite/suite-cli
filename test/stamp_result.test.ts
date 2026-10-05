import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serializeConfig, emptyConfig } from "../src/config.ts";
import { EXIT_CODES, RESULT_FIELDS, renderStampResult, emptyResult } from "../src/stamp_result.ts";
import { canary, listFiles, scanTexts, scanTree } from "./leak-scan.ts";

/**
 * The machine contract, observed from OUTSIDE: a real subprocess, its real
 * stdout, stderr and exit code. In-process tests cannot see a stray write to
 * fd 1, which is exactly the defect "one JSON document" exists to rule out.
 */
const FIXTURE = resolve(import.meta.dir, "fixtures", "stamp-fixture.ts");

let dir: string;
let home: string;
let root: string;
let tokenPath: string;
let token: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `suite-stampresult-01a0d8f8-${process.pid}-`));
  home = join(dir, "home");
  mkdirSync(join(home, "tmux"), { recursive: true });
  root = join(home, "agents", "fake-agent");
  tokenPath = join(dir, "runtime.token");
  token = canary("tok");
  writeFileSync(tokenPath, token);
  chmodSync(tokenPath, 0o600);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  doc: Record<string, unknown>;
}

async function run(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<Run> {
  const proc = Bun.spawn(["bun", FIXTURE, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMUX_TMPDIR: join(home, "tmux"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      ...env,
    },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // EXACTLY one document: JSON.parse rejects trailing content, so a second
  // document or a stray human line on stdout fails right here.
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`stdout is not exactly one JSON document (exit ${code}); stderr:\n${stderr}`);
  }
  return { code, stdout, stderr, doc };
}

const baseArgs = (): string[] => [
  "--root",
  root,
  "--suite-url",
  "https://suite.example.invalid",
  "--runtime-id",
  "fake-01a0d8f8-rt",
  "--token-ref",
  `file:${tokenPath}`,
];

describe("one JSON document on stdout", () => {
  test("even when the writer prints human lines through console.log and process.stdout", async () => {
    const r = await run(baseArgs(), { STAMP_FIXTURE_NOISE: "1" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("a human line from console.log");
    expect(r.stderr).toContain("a human line from process.stdout.write");
    expect(r.stdout).not.toContain("a human line");
    expect(r.stdout.endsWith("}\n")).toBe(true);
  });

  test("the document carries every contract field, in order, and contract_version 1", async () => {
    const r = await run(baseArgs());
    expect(Object.keys(r.doc)).toEqual([...RESULT_FIELDS]);
    expect(r.doc.contract_version).toBe(1);
    expect(r.doc.ok).toBe(true);
    expect(r.doc.harness).toBe("fake");
    expect(r.doc.agent).toEqual({ name: "fake-agent", root, runtime_id: "fake-01a0d8f8-rt" });
    expect(r.doc.token_ref).toBe(`file:${tokenPath}`);
    expect(r.doc.changed).toBe(true);
    expect(r.doc.validation).toEqual({ verdict: "pass", checks: [{ command: "fake check", exit_code: 0, verdict: "pass" }] });
    expect(r.doc.harness_version).toBe("1.0.0");
    expect(r.doc.writer_version).toBe(1);
    expect(r.doc.warnings).toEqual([]);
    expect(r.doc.human_steps).toEqual([{ kind: "start_agent_session", text: `suite fake --root ${root}` }]);
    expect(r.doc.error).toBeNull();
    const actions = r.doc.actions as { kind: string; outcome: string }[];
    expect(actions.map((a) => a.kind)).toEqual(["identity", "config_set", "stamp_record"]);
    expect(actions.every((a) => a.outcome === "written")).toBe(true);
  });

  test("renderStampResult is indent 2 with a trailing newline, and redacts known values", () => {
    const secret = canary();
    const r = emptyResult("fake", 1);
    r.error = { code: "x", message: `oops ${secret}` };
    const text = renderStampResult(r, [secret]);
    expect(text.startsWith('{\n  "contract_version": 1,')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain(secret);
  });
});

describe("every exit code is driven", () => {
  test("the contract defines exactly 0, 1, 2, 3", () => {
    expect(Object.keys(EXIT_CODES)).toEqual(["0", "1", "2", "3"]);
  });

  test("0: stamped and checked", async () => {
    expect((await run(baseArgs())).code).toBe(0);
  });

  test("1: the post-write check failed", async () => {
    const r = await run(baseArgs(), { STAMP_FIXTURE_VERDICT: "fail" });
    expect(r.code).toBe(1);
    expect(r.doc.ok).toBe(false);
    expect((r.doc.error as { code: string }).code).toBe("validation_failed");
  });

  test("1: unparseable check output, carrying the raw line", async () => {
    const r = await run(baseArgs(), { STAMP_FIXTURE_VERDICT: "unparseable" });
    expect(r.code).toBe(1);
    const v = r.doc.validation as { verdict: string; checks: { raw?: string }[] };
    expect(v.verdict).toBe("unparseable");
    expect(v.checks[0]?.raw).toBe("??? garbled status line");
  });

  test("2: a literal --token, and neither output carries it", async () => {
    const secret = canary("tok");
    const r = await run(["--root", root, "--token", secret]);
    expect(r.code).toBe(2);
    expect((r.doc.error as { code: string }).code).toBe("literal_token_refused");
    expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, secret)).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  test("2: a token piped on stdin, and neither output carries it", async () => {
    const secret = canary("tok");
    const r = await run(baseArgs(), {}, secret);
    expect(r.code).toBe(2);
    expect((r.doc.error as { code: string }).code).toBe("stdin_token_refused");
    expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, secret)).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  test("positive control for stdin: an empty stdin is not refused", async () => {
    expect((await run(baseArgs(), {}, "")).code).toBe(0);
  });

  test("an open but silent stdin pipe (how execFile callers spawn) is allowed and does not hang", async () => {
    const proc = Bun.spawn(["bun", FIXTURE, ...baseArgs()], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMUX_TMPDIR: join(home, "tmux") },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(JSON.parse(await new Response(proc.stdout).text()).ok).toBe(true);
  });

  test("2: a loosened token file names path and mode; nothing is written", async () => {
    chmodSync(tokenPath, 0o644);
    const r = await run(baseArgs());
    expect(r.code).toBe(2);
    const err = r.doc.error as { code: string; message: string };
    expect(err.code).toBe("token_file_mode");
    expect(err.message).toContain(tokenPath);
    expect(err.message).toContain("0644");
    expect(existsSync(root)).toBe(false);
  });

  test("2: operator headers", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "suite.json"), serializeConfig({ ...emptyConfig(), headerNames: ["X-Example-Id"] }));
    const r = await run(baseArgs());
    expect(r.code).toBe(2);
    expect((r.doc.error as { code: string }).code).toBe("headers_unsupported");
  });

  test("2: harness absent", async () => {
    const r = await run(baseArgs(), { STAMP_FIXTURE_ABSENT: "1" });
    expect(r.code).toBe(2);
    expect((r.doc.error as { code: string }).code).toBe("harness_absent");
  });

  test("2: keychain off darwin", async () => {
    const r = await run(
      ["--root", root, "--suite-url", "u", "--runtime-id", "r", "--token-ref", "keychain:X", "--keychain-service", "Y"],
      { STAMP_FIXTURE_PLATFORM: "linux" },
    );
    expect(r.code).toBe(2);
    expect((r.doc.error as { message: string }).message).toBe("keychain refs are macOS-only");
  });

  test("3: a keychain that does not answer is blocked on a human", async () => {
    const bin = join(dir, "security");
    writeFileSync(bin, "#!/bin/sh\nexit 44\n");
    chmodSync(bin, 0o755);
    const r = await run(
      ["--root", root, "--suite-url", "u", "--runtime-id", "r", "--token-ref", "keychain:X", "--keychain-service", "Y"],
      { STAMP_FIXTURE_PLATFORM: "darwin", STAMP_FIXTURE_SECURITY: bin, STAMP_FIXTURE_NEEDS_VALUE: "1" },
    );
    expect(r.code).toBe(3);
    expect((r.doc.error as { code: string }).code).toBe("keychain_unavailable");
    // Exit 44 is "no such item" (0.8.0 names it; it used to say keychain_unlock).
    expect((r.doc.human_steps as { kind: string }[]).map((s) => s.kind)).toEqual(["keychain_item_missing"]);
    // Blocked before any write.
    expect(existsSync(root)).toBe(false);
  });
});

describe("idempotence and leaks", () => {
  test("a second identical run returns changed:false with every action unchanged", async () => {
    const first = await run(baseArgs());
    expect(first.doc.changed).toBe(true);
    const second = await run(baseArgs());
    expect(second.code).toBe(0);
    expect(second.doc.changed).toBe(false);
    const actions = second.doc.actions as { outcome: string }[];
    expect(actions.length).toBe(3);
    expect(actions.every((a) => a.outcome === "unchanged")).toBe(true);
  });

  test("with the value resolved in memory, it appears in no output and no file under HOME", async () => {
    const r = await run(baseArgs(), { STAMP_FIXTURE_NEEDS_VALUE: "1", STAMP_FIXTURE_NOISE: "1" });
    expect(r.code).toBe(0);
    expect(listFiles(home).length).toBeGreaterThanOrEqual(3);
    expect(scanTree(home, token)).toEqual([]);
    expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, token)).toEqual([]);
    // Positive control: the same scan finds the value in the sanctioned file.
    expect(scanTree(dir, token).map((h) => h.where)).toEqual([tokenPath]);
  });
});
