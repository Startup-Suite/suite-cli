import { describe, expect, test } from "bun:test";
import { ForbiddenOverride, harnessChildEnv, spawnHarness } from "../src/harness_env.ts";
import { SecretInArgv } from "../src/secrets.ts";
import { canary, scanEnv, scanText } from "./leak-scan.ts";

const CANARY_NAMES = [
  "SUITE_RUNTIME_TOKEN",
  "SUITE_URL",
  "HERMES_HOME",
  "HERMES_PROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "SOME_UNLISTED_API_KEY",
] as const;

function baseWithCanaries(value: string): Record<string, string> {
  const base: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/home-01a0d8f8",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm",
    TMUX_TMPDIR: "/tmp/tmux-01a0d8f8",
  };
  for (const n of CANARY_NAMES) base[n] = value;
  return base;
}

describe("harnessChildEnv", () => {
  test("canaries under SUITE_*, HERMES_*, OPENCLAW_* and unlisted names are stripped", () => {
    const value = canary("env");
    const env = harnessChildEnv(baseWithCanaries(value));
    for (const n of CANARY_NAMES) expect(env[n]).toBeUndefined();
    expect(scanEnv("child", env, value)).toEqual([]);
  });

  test("positive control: the same scan finds the canary in the unfiltered base", () => {
    const value = canary("env");
    expect(scanEnv("base", baseWithCanaries(value), value).length).toBe(CANARY_NAMES.length);
  });

  test("allowlisted names pass through unchanged", () => {
    const env = harnessChildEnv(baseWithCanaries("x"));
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home-01a0d8f8",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "xterm",
      TMUX_TMPDIR: "/tmp/tmux-01a0d8f8",
    });
  });

  test("overrides set the harness's own dir vars, including OPENCLAW_* and HERMES_*", () => {
    const env = harnessChildEnv(baseWithCanaries("inherited"), {
      OPENCLAW_STATE_DIR: "/root-a/.openclaw",
      HERMES_HOME: "/root-a/.hermes",
    });
    expect(env.OPENCLAW_STATE_DIR).toBe("/root-a/.openclaw");
    expect(env.HERMES_HOME).toBe("/root-a/.hermes");
    // Only the override, not the inherited value, survives.
    expect(Object.values(env)).not.toContain("inherited");
  });

  test("an override can never hand a child a SUITE_* credential", () => {
    expect(() => harnessChildEnv({}, { SUITE_RUNTIME_TOKEN: "x" })).toThrow(ForbiddenOverride);
    expect(() => harnessChildEnv({}, { SUITE_MCP_KEY: "x" })).toThrow(ForbiddenOverride);
  });
});

describe("spawnHarness", () => {
  test("a real child sees no stripped canary; positive control sees an overridden one", async () => {
    const value = canary("env");
    const base = { ...process.env, ...baseWithCanaries(value), PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const clean = await spawnHarness(["env"], { env: harnessChildEnv(base) });
    expect(clean.exitCode).toBe(0);
    expect(scanText("child env", clean.stdout, value)).toEqual([]);
    expect(clean.stdout).toContain("TMUX_TMPDIR=/tmp/tmux-01a0d8f8");

    const control = await spawnHarness(["env"], { env: harnessChildEnv(base, { HERMES_HOME: value }) });
    expect(scanText("child env", control.stdout, value)).not.toEqual([]);
  });

  test("a secret for stdin reaches the child's stdin, and not its argv or env", async () => {
    const secret = canary("tok");
    const env = harnessChildEnv(process.env);
    const r = await spawnHarness(["sh", "-c", 'wc -c; tr "\\0" " " < /proc/$$/cmdline; echo; env'], {
      env,
      stdinSecret: secret,
    });
    expect(r.exitCode).toBe(0);
    const [count, ...rest] = r.stdout.split("\n");
    expect(Number((count ?? "").trim())).toBe(secret.length);
    expect(scanText("child argv+env", rest.join("\n"), secret)).toEqual([]);
  });

  test("argv carrying a secret throws before the child exists", async () => {
    const secret = canary("tok");
    await expect(
      spawnHarness(["echo", `--token=${secret}`], { env: harnessChildEnv(process.env), stdinSecret: secret }),
    ).rejects.toThrow(SecretInArgv);
  });

  test("an env value carrying a secret throws; secretEnv is the one sanctioned env route", async () => {
    const secret = canary("key");
    await expect(
      spawnHarness(["true"], { env: { ...harnessChildEnv(process.env), X: secret }, secrets: [secret] }),
    ).rejects.toThrow(/carries a secret/);
    const r = await spawnHarness(["sh", "-c", 'test -n "$CUSTOM_API_KEY"'], {
      env: harnessChildEnv(process.env),
      secretEnv: { CUSTOM_API_KEY: secret },
    });
    expect(r.exitCode).toBe(0);
  });
});
