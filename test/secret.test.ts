/**
 * `suite secret put|delete` (task 01a0d6b9 stage 1): the only keychain writers
 * the Mac app runs.
 *
 * `security` is an in-process fake keychain behind the injected exec seam. It
 * records every argv AND the bytes each call received on stdin, so the tests
 * can show where the value went: into `security -i`'s stdin, hex-encoded, and
 * nowhere else — not argv, not the document, not stderr.
 */
import { describe, expect, test } from "bun:test";
import { SECURITY_TIMEOUT_MS } from "../src/tuning.ts";
import {
  SECURITY_TIMED_OUT,
  addCommandLine,
  parseSecretArgs,
  runSecret,
  runSecretInner,
  sha256Prefix,
  type SecretDeps,
} from "../src/commands/secret.ts";
import { SECURITY_BIN } from "../src/token_ref.ts";
import { canary, scanText, scanTexts } from "./leak-scan.ts";

interface Call {
  bin: string;
  args: string[];
  stdin: string | undefined;
}

/** A fake keychain: `-i` stdin commands write, find-generic-password reads, delete removes. */
function fakeKeychain(options: { writeExit?: number; readBack?: (v: string) => string } = {}) {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const exec: NonNullable<SecretDeps["exec"]> = async (bin, args, stdin) => {
    calls.push({ bin, args, stdin });
    if (args[0] === "-i") {
      if ((options.writeExit ?? 0) !== 0) return { exitCode: options.writeExit as number, stdout: "" };
      const m = /^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -X ([0-9a-f]+)\n$/.exec(stdin ?? "");
      if (m === null) return { exitCode: 1, stdout: "" };
      items.set(`${m[1]}\u0000${m[2]}`, Buffer.from(m[3] as string, "hex").toString("utf8"));
      return { exitCode: 0, stdout: "" };
    }
    if (args[0] === "find-generic-password") {
      const v = items.get(`${args[2]}\u0000${args[4]}`);
      if (v === undefined) return { exitCode: 44, stdout: "" };
      return { exitCode: 0, stdout: `${options.readBack ? options.readBack(v) : v}\n` };
    }
    if (args[0] === "delete-generic-password") {
      const key = `${args[2]}\u0000${args[4]}`;
      if (!items.has(key)) return { exitCode: 44, stdout: "" };
      items.delete(key);
      return { exitCode: 0, stdout: "" };
    }
    return { exitCode: 2, stdout: "" };
  };
  return { items, calls, exec };
}

function deps(k: ReturnType<typeof fakeKeychain>, stdin: string | null): SecretDeps {
  return {
    platform: "darwin",
    exec: k.exec,
    readStdin: async () => (stdin === null ? { tty: true } : { tty: false, value: stdin }),
  };
}

const PUT = ["put", "--keychain-service", "suite-01a0d6b9-test", "--item", "RUNTIME_TOKEN.rt-01a0d6b9"];

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) };
}

describe("suite secret put", () => {
  test("writes through `security -i` on stdin, reads back, and prints names and a sha256 prefix", async () => {
    const value = canary("tok");
    const k = fakeKeychain();
    const sink = io();
    const code = await runSecret(PUT, deps(k, `${value}\n`), sink);
    expect(code).toBe(0);
    const doc = JSON.parse(sink.out.join(""));
    expect(doc).toEqual({
      contract_version: 1,
      ok: true,
      action: "put",
      service: "suite-01a0d6b9-test",
      item: "RUNTIME_TOKEN.rt-01a0d6b9",
      sha256_prefix: sha256Prefix(value),
      human_steps: [],
      error: null,
    });
    expect(doc.sha256_prefix).toMatch(/^[0-9a-f]{12}$/);
    // The keychain holds exactly the value (one trailing newline stripped).
    expect(k.items.get("suite-01a0d6b9-test\u0000RUNTIME_TOKEN.rt-01a0d6b9")).toBe(value);
    // Absolute binary; the write then the read-back.
    expect(k.calls.map((c) => [c.bin, c.args[0]])).toEqual([
      [SECURITY_BIN, "-i"],
      [SECURITY_BIN, "find-generic-password"],
    ]);
  });

  test("LEAK: the value is in no argv, not the document, not stderr — only security's stdin, hex", async () => {
    const value = canary("tok");
    const k = fakeKeychain();
    const sink = io();
    await runSecret(PUT, deps(k, value), sink);
    const hex = Buffer.from(value).toString("hex");
    const argv = k.calls.map((c) => [c.bin, ...c.args].join(" ")).join("\n");
    expect(scanTexts({ argv, stdout: sink.out.join(""), stderr: sink.err.join("") }, value)).toEqual([]);
    expect(argv.includes(hex)).toBe(false);
    // Positive control: the scanner and this harness CAN see the value where it is sanctioned.
    expect(k.calls[0]?.stdin).toBe(addCommandLine("suite-01a0d6b9-test", "RUNTIME_TOKEN.rt-01a0d6b9", value));
    expect(k.calls[0]?.stdin?.includes(hex)).toBe(true);
    expect(scanText("planted", `x ${value} y`, value).length).toBeGreaterThan(0);
  });

  test("a terminal on stdin is refused (exit 2): a typed value would echo", async () => {
    const k = fakeKeychain();
    const r = await runSecretInner(PUT, deps(k, null));
    expect(r.exitCode).toBe(2);
    expect(r.result.error?.code).toBe("stdin_is_tty");
    expect(k.calls).toEqual([]);
  });

  test("an empty value is refused (exit 2) and nothing is written", async () => {
    const k = fakeKeychain();
    for (const empty of ["", "\n"]) {
      const r = await runSecretInner(PUT, deps(k, empty));
      expect(r.exitCode).toBe(2);
      expect(r.result.error?.code).toBe("secret_empty");
    }
    expect(k.calls).toEqual([]);
  });

  test("a value flag is refused (exit 2) without repeating it", async () => {
    const value = canary("tok");
    for (const args of [[...PUT, "--value", value], [...PUT, `--value=${value}`], [...PUT, "-w", value], [...PUT, value]]) {
      const k = fakeKeychain();
      const sink = io();
      expect(await runSecret(args, deps(k, "x"), sink)).toBe(2);
      expect(scanTexts({ out: sink.out.join(""), err: sink.err.join("") }, value)).toEqual([]);
      expect(k.calls).toEqual([]);
    }
  });

  test("a locked keychain (security exit 36, what ssh gets) is blocked on a human: exit 3, keychain_unlock", async () => {
    const k = fakeKeychain({ writeExit: 36 });
    const r = await runSecretInner(PUT, deps(k, canary()));
    expect(r.exitCode).toBe(3);
    expect(r.result.error?.code).toBe("keychain_locked");
    expect(r.result.human_steps.map((s) => s.kind)).toEqual(["keychain_unlock"]);
    expect(r.result.human_steps[0]?.command).toContain("security unlock-keychain");
    expect(r.result.human_steps[0]?.url).toStartWith("https://support.apple.com/");
  });

  test("a security that never answers is killed and reported as a human step (exit 3), not a hang", async () => {
    const k = fakeKeychain({ writeExit: SECURITY_TIMED_OUT });
    const r = await runSecretInner(PUT, deps(k, canary()));
    expect(r.exitCode).toBe(3);
    expect(r.result.human_steps[0]?.kind).toBe("keychain_unlock");
    expect(r.result.human_steps[0]?.text).toContain("did not answer in time");
  });

  test("the live runner kills a security that hangs (measured: a HOME with no login keychain makes it wait)", async () => {
    const dir = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/suite-secret-hang-01a0d6b9-`);
    const bin = `${dir}/security`;
    (await import("node:fs")).writeFileSync(bin, "#!/bin/sh\nexec sleep 60\n");
    (await import("node:fs")).chmodSync(bin, 0o755);
    const started = Date.now();
    const r = await runSecretInner(PUT, { platform: "darwin", securityBin: bin, readStdin: async () => ({ tty: false, value: "v" }) });
    expect(r.exitCode).toBe(3);
    expect(Date.now() - started).toBeLessThan(SECURITY_TIMEOUT_MS + 5_000);
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("another write failure is exit 1, not a human step", async () => {
    const r = await runSecretInner(PUT, deps(fakeKeychain({ writeExit: 45 }), canary()));
    expect(r.exitCode).toBe(1);
    expect(r.result.error?.code).toBe("keychain_write_failed");
  });

  test("a read-back that differs is a failure (exit 1), and the mismatch prints no value", async () => {
    const value = canary("tok");
    const k = fakeKeychain({ readBack: (v) => `${v}x` });
    const sink = io();
    expect(await runSecret(PUT, deps(k, value), sink)).toBe(1);
    const doc = JSON.parse(sink.out.join(""));
    expect(doc.error.code).toBe("keychain_readback_mismatch");
    expect(doc.sha256_prefix).toBeNull();
    expect(scanTexts({ out: sink.out.join(""), err: sink.err.join("") }, value)).toEqual([]);
  });

  test("off macOS it is refused (exit 2) and security is never run", async () => {
    const k = fakeKeychain();
    const r = await runSecretInner(PUT, { ...deps(k, "x"), platform: "linux" });
    expect(r.exitCode).toBe(2);
    expect(r.result.error?.code).toBe("keychain_unsupported_platform");
    expect(k.calls).toEqual([]);
  });

  test("names must be plain words: whitespace, quotes and backslashes are refused", () => {
    for (const bad of ["a b", 'a"b', "a\\b", "a'b", "a\nb"]) {
      expect(() => parseSecretArgs(["put", "--keychain-service", "svc", "--item", bad])).toThrow();
      expect(() => parseSecretArgs(["put", "--keychain-service", bad, "--item", "i"])).toThrow();
    }
    expect(parseSecretArgs(["delete", "--keychain-service=svc", "--item=RUNTIME_TOKEN.x"])).toEqual({
      action: "delete",
      service: "svc",
      item: "RUNTIME_TOKEN.x",
    });
  });
});

describe("suite secret delete", () => {
  test("removes an item; deleting an absent one is ok with deleted: false", async () => {
    const k = fakeKeychain();
    await runSecretInner(PUT, deps(k, "v"));
    const del = ["delete", "--keychain-service", "suite-01a0d6b9-test", "--item", "RUNTIME_TOKEN.rt-01a0d6b9"];
    const first = await runSecretInner(del, deps(k, null));
    expect(first.exitCode).toBe(0);
    expect(first.result).toMatchObject({ ok: true, action: "delete", deleted: true });
    expect(k.items.size).toBe(0);
    const again = await runSecretInner(del, deps(k, null));
    expect(again.exitCode).toBe(0);
    expect(again.result.deleted).toBe(false);
    expect(k.calls.at(-1)?.args).toEqual(["delete-generic-password", "-s", "suite-01a0d6b9-test", "-a", "RUNTIME_TOKEN.rt-01a0d6b9"]);
  });
});
