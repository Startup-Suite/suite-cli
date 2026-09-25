import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StampFailure } from "../src/stamp_result.ts";
import {
  SECURITY_BIN,
  checkFileRef,
  parseTokenRef,
  resolveTokenRef,
  securityArgs,
  takeTokenRefFlags,
  validateTokenRef,
} from "../src/token_ref.ts";
import { canary, scanText } from "./leak-scan.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `suite-tokenref-01a0d8f8-${process.pid}-`));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run `fn`, expect a StampFailure, and return it. */
function failure(fn: () => unknown): StampFailure {
  try {
    fn();
  } catch (e) {
    if (e instanceof StampFailure) return e;
    throw e;
  }
  throw new Error("expected a StampFailure, got none");
}

async function failureAsync(fn: () => Promise<unknown>): Promise<StampFailure> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof StampFailure) return e;
    throw e;
  }
  throw new Error("expected a StampFailure, got none");
}

function tokenFile(mode: number, content: string): string {
  const p = join(dir, `token-${mode.toString(8)}`);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

describe("literal tokens are refused in every spelling", () => {
  test("--token VALUE exits 2, names argv, does not repeat the value", () => {
    const secret = canary("tok");
    const f = failure(() => takeTokenRefFlags(["--root", "/x", "--token", secret]));
    expect(f.exitCode).toBe(2);
    expect(f.code).toBe("literal_token_refused");
    expect(f.message).toContain("/proc/<pid>/cmdline");
    expect(scanText("message", f.message, secret)).toEqual([]);
  });

  test("--token=VALUE exits 2 without repeating the value", () => {
    const secret = canary("tok");
    const f = failure(() => takeTokenRefFlags([`--token=${secret}`]));
    expect(f.exitCode).toBe(2);
    expect(scanText("message", f.message, secret)).toEqual([]);
    expect(f.message).toContain("--token is refused");
  });

  test("a --token-ref that is a literal value exits 2 without repeating it", () => {
    const secret = canary("tok");
    const f = failure(() => parseTokenRef(secret));
    expect(f.exitCode).toBe(2);
    expect(f.code).toBe("literal_token_refused");
    expect(scanText("message", f.message, secret)).toEqual([]);
  });

  test("a stdin ref exits 2", () => {
    for (const raw of ["-", "stdin", "stdin:"]) {
      const f = failure(() => parseTokenRef(raw));
      expect(f.exitCode).toBe(2);
      expect(f.code).toBe("stdin_token_refused");
    }
    expect(failure(() => takeTokenRefFlags(["--token-stdin"])).exitCode).toBe(2);
  });

  test("positive control: well-formed refs parse, both flag spellings", () => {
    const flags = takeTokenRefFlags(["--token-ref", "file:/a/b", "--keychain-service=svc", "--root", "/r"]);
    expect(flags).toEqual({ tokenRef: "file:/a/b", keychainService: "svc", rest: ["--root", "/r"] });
    expect(parseTokenRef("file:/a/b")).toEqual({ kind: "file", path: "/a/b", raw: "file:/a/b" });
    expect(parseTokenRef("keychain:item", { keychainService: "svc" })).toEqual({
      kind: "keychain",
      item: "item",
      service: "svc",
      raw: "keychain:item",
    });
  });

  test("scanning stops at --, so harness args pass through untouched", () => {
    const flags = takeTokenRefFlags(["--token-ref", "file:/a", "--", "--token-ref", "harness-own"]);
    expect(flags.tokenRef).toBe("file:/a");
    expect(flags.rest).toEqual(["--", "--token-ref", "harness-own"]);
  });

  test("a relative file: path and a keychain ref without a service are refused", () => {
    expect(failure(() => parseTokenRef("file:relative/p")).code).toBe("token_ref_invalid");
    expect(failure(() => parseTokenRef("keychain:item")).code).toBe("keychain_service_missing");
    expect(failure(() => parseTokenRef("keychain:", { keychainService: "s" })).code).toBe("token_ref_invalid");
  });
});

describe("file: refs are checked by stat, never by read", () => {
  test("0644 is refused, naming path and mode, never the content", () => {
    const secret = canary("tok");
    const p = tokenFile(0o644, secret);
    const f = failure(() => checkFileRef(p));
    expect(f.exitCode).toBe(2);
    expect(f.code).toBe("token_file_mode");
    expect(f.message).toContain(p);
    expect(f.message).toContain("0644");
    expect(scanText("message", f.message, secret)).toEqual([]);
  });

  test("positive control: 0600 and 0400 pass", () => {
    expect(() => checkFileRef(tokenFile(0o600, "x"))).not.toThrow();
    expect(() => checkFileRef(tokenFile(0o400, "x"))).not.toThrow();
  });

  test("0640 and 0700 are refused too: only owner read(-write) passes", () => {
    expect(failure(() => checkFileRef(tokenFile(0o640, "x"))).code).toBe("token_file_mode");
    expect(failure(() => checkFileRef(tokenFile(0o700, "x"))).code).toBe("token_file_mode");
  });

  test("a foreign-owned 0600 file is refused (owner injected: no root needed)", () => {
    const p = tokenFile(0o600, "x");
    const me = process.getuid?.() ?? 0;
    const f = failure(() => checkFileRef(p, { uid: me + 1 }));
    expect(f.code).toBe("token_file_foreign_owner");
    expect(() => checkFileRef(p, { uid: me })).not.toThrow();
  });

  test("a symlink to a 0600 file and a missing file are refused", () => {
    const target = tokenFile(0o600, "x");
    const link = join(dir, "link");
    symlinkSync(target, link);
    expect(failure(() => checkFileRef(link)).code).toBe("token_file_not_regular");
    expect(failure(() => checkFileRef(join(dir, "absent"))).code).toBe("token_file_missing");
  });

  test("resolve reads a 0600 file into memory, stripping exactly one trailing newline", async () => {
    const secret = canary("tok");
    expect(await resolveTokenRef(parseTokenRef(`file:${tokenFile(0o600, `${secret}\n`)}`))).toBe(secret);
    const twice = join(dir, "twice");
    writeFileSync(twice, `${secret}\n\n`);
    chmodSync(twice, 0o600);
    expect(await resolveTokenRef(parseTokenRef(`file:${twice}`))).toBe(`${secret}\n`);
  });

  test("an empty token file is refused", async () => {
    const f = await failureAsync(() => resolveTokenRef(parseTokenRef(`file:${tokenFile(0o600, "")}`)));
    expect(f.code).toBe("token_file_empty");
  });
});

describe("keychain: refs", () => {
  /**
   * A fake `security` that records its argv, one arg per line, and answers
   * with a value or an exit code. Reached through the securityBin seam: the
   * production resolver calls an absolute path, so PATH cannot reach it (the
   * next test pins that).
   */
  function fakeSecurity(value: string, exitCode = 0): { bin: string; argvLog: string } {
    const bin = join(dir, "bin", "security");
    const argvLog = join(dir, "security-argv-01a0d8f8.log");
    Bun.spawnSync(["mkdir", "-p", join(dir, "bin")]);
    writeFileSync(
      bin,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}'; done\n` +
        (exitCode === 0 ? `printf '%s\\n' '${value}'\n` : `exit ${exitCode}\n`),
    );
    chmodSync(bin, 0o755);
    return { bin, argvLog };
  }

  test("the production call is the absolute /usr/bin/security with names only", () => {
    expect(SECURITY_BIN).toBe("/usr/bin/security");
    expect(securityArgs({ item: "RUNTIME_TOKEN.agent", service: "svc" })).toEqual([
      "find-generic-password",
      "-s",
      "svc",
      "-a",
      "RUNTIME_TOKEN.agent",
      "-w",
    ]);
  });

  test("a security first on PATH is NOT what the resolver runs: it execs the absolute path", async () => {
    const { bin } = fakeSecurity("unused");
    const calls: string[] = [];
    const saved = process.env.PATH;
    process.env.PATH = `${join(dir, "bin")}:${saved ?? ""}`;
    try {
      const ref = parseTokenRef("keychain:item", { keychainService: "svc" });
      await resolveTokenRef(ref, {
        platform: "darwin",
        exec: async (b) => {
          calls.push(b);
          return { exitCode: 0, stdout: "v\n" };
        },
      });
    } finally {
      process.env.PATH = saved;
    }
    expect(calls).toEqual(["/usr/bin/security"]);
    expect(calls).not.toContain(bin);
  });

  test("argv carries the names only; the value reaches memory and not argv", async () => {
    const secret = canary("tok");
    const { bin, argvLog } = fakeSecurity(secret);
    const ref = parseTokenRef("keychain:RUNTIME_TOKEN.agent", { keychainService: "example-svc" });
    const value = await resolveTokenRef(ref, { platform: "darwin", securityBin: bin });
    expect(value).toBe(secret);
    const argv = readFileSync(argvLog, "utf8").trimEnd().split("\n");
    expect(argv).toEqual(["find-generic-password", "-s", "example-svc", "-a", "RUNTIME_TOKEN.agent", "-w"]);
    expect(scanText("security argv", argv.join("\n"), secret)).toEqual([]);
    // Positive control for that scan: the value IS findable where it went.
    expect(scanText("resolved", value, secret)).not.toEqual([]);
  });

  test("off darwin it is refused with exit 2 and security is never run", async () => {
    const { bin, argvLog } = fakeSecurity("unused");
    const ref = parseTokenRef("keychain:item", { keychainService: "svc" });
    const f = await failureAsync(() => resolveTokenRef(ref, { platform: "linux", securityBin: bin }));
    expect(f.exitCode).toBe(2);
    expect(f.message).toBe("keychain refs are macOS-only");
    expect(existsSync(argvLog)).toBe(false);
    expect(failure(() => validateTokenRef(ref, { platform: "linux" })).code).toBe("keychain_unsupported_platform");
  });

  test("a missing item (security exit 44) is blocked on a human: exit 3, keychain_unlock", async () => {
    const { bin } = fakeSecurity("", 44);
    const ref = parseTokenRef("keychain:item", { keychainService: "svc" });
    const f = await failureAsync(() => resolveTokenRef(ref, { platform: "darwin", securityBin: bin }));
    expect(f.exitCode).toBe(3);
    expect(f.code).toBe("keychain_unavailable");
    expect(f.humanSteps.map((s) => s.kind)).toEqual(["keychain_unlock"]);
    expect(f.message).toContain("item");
    expect(f.message).toContain("svc");
  });

  test("a locked keychain (any other non-zero exit) is exit 3 too", async () => {
    const { bin } = fakeSecurity("", 36);
    const ref = parseTokenRef("keychain:item", { keychainService: "svc" });
    expect((await failureAsync(() => resolveTokenRef(ref, { platform: "darwin", securityBin: bin }))).exitCode).toBe(3);
  });

  test("a security binary that cannot be run is a failure (exit 1), not a human block", async () => {
    const ref = parseTokenRef("keychain:item", { keychainService: "svc" });
    const f = await failureAsync(() =>
      resolveTokenRef(ref, { platform: "darwin", securityBin: join(dir, "no-such-security") }),
    );
    expect(f.exitCode).toBe(1);
  });
});
