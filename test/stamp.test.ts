import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, serializeConfig, emptyConfig } from "../src/config.ts";
import {
  IDENTITY_FILE,
  STAMP_FILE,
  inputsDigest,
  runStamp,
  unverifiedWarning,
  type StampInputs,
  type StampRequest,
} from "../src/stamp.ts";
import { aggregateVerdict, type StampIO } from "../src/stamp_result.ts";
import { parseTokenRef } from "../src/token_ref.ts";
import { FAKE_CONFIG, fakeWriter, type FakeWriterOptions } from "./fixtures/fake_writer.ts";
import { canary, scanTree, scanTexts } from "./leak-scan.ts";

let dir: string;
let root: string;
let tokenPath: string;
let token: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `suite-stamp-01a0d8f8-${process.pid}-`));
  root = join(dir, "agents", "fake-agent");
  tokenPath = join(dir, "runtime.token");
  token = canary("tok");
  writeFileSync(tokenPath, `${token}\n`);
  chmodSync(tokenPath, 0o600);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function captureIO(): StampIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) };
}

function request(extra: Partial<StampRequest> = {}): StampRequest {
  return {
    root,
    name: "fake-agent",
    suiteUrl: "https://suite.example.invalid",
    runtimeId: "fake-01a0d8f8-rt",
    tokenRef: `file:${tokenPath}`,
    ...extra,
  };
}

const quiet = { stdin: async () => "none" as const };

async function stamp(
  options: FakeWriterOptions = {},
  extra: Partial<StampRequest> = {},
  platform: NodeJS.Platform = process.platform,
) {
  const writer = fakeWriter(options);
  const io = captureIO();
  const run = await runStamp(writer, () => request(extra), io, { ...quiet, resolve: { platform } });
  return { ...run, io, writer };
}

describe("harness version measurement", () => {
  test("an unmeasured version gives exactly one warning and is not a failure", async () => {
    const { result, exitCode, io } = await stamp({ version: "9.9.9" });
    expect(result.warnings).toEqual([unverifiedWarning("fake", "9.9.9")]);
    expect(result.warnings[0]).toBe("config shape unverified for fake 9.9.9");
    expect(io.err.filter((l) => l.includes("config shape unverified")).length).toBe(1);
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
  });

  test("positive control: a measured version gives no warning", async () => {
    const { result } = await stamp({ version: "1.0.0" });
    expect(result.warnings).toEqual([]);
  });

  test("an absent harness is refused (exit 2) and writes nothing", async () => {
    const { result, exitCode } = await stamp({ version: null });
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("harness_absent");
    expect(result.error?.message).toContain("--install-fake");
    expect(existsSync(root)).toBe(false);
  });
});

describe("the stamp record and its digest", () => {
  function inputsWith(tokenValue: string | undefined): StampInputs {
    return {
      name: "a",
      root,
      suiteUrl: "https://suite.example.invalid",
      runtimeId: "rt",
      tokenRef: parseTokenRef(`file:${tokenPath}`),
      tokenValue,
      nonSecret: { model: "m", contextLength: 65536 },
      harnessVersion: "1.0.0",
      env: {},
    };
  }

  test("the digest excludes the token value: two values behind one ref digest identically", () => {
    const w = fakeWriter();
    expect(inputsDigest(inputsWith(canary()), w)).toBe(inputsDigest(inputsWith(canary()), w));
    expect(inputsDigest(inputsWith(undefined), w)).toBe(inputsDigest(inputsWith(canary()), w));
  });

  test("positive control: the digest does move when a non-secret input moves", () => {
    const w = fakeWriter();
    const a = inputsWith(undefined);
    const b = { ...inputsWith(undefined), nonSecret: { model: "other", contextLength: 65536 } };
    expect(inputsDigest(a, w)).not.toBe(inputsDigest(b, w));
  });

  test("a non-secret input carrying the token value is refused rather than digested", () => {
    const value = canary();
    const i = { ...inputsWith(value), nonSecret: { oops: value } };
    expect(() => inputsDigest(i, fakeWriter())).toThrow(/carries the token value/);
  });

  test("the record holds the ref string, the digest and the verdict; never the value", async () => {
    const { result } = await stamp({ needsValue: true });
    expect(result.ok).toBe(true);
    const record = JSON.parse(readFileSync(join(root, STAMP_FILE), "utf8"));
    expect(Object.keys(record)).toEqual([
      "harness",
      "writerVersion",
      "harnessVersion",
      "pluginRef",
      "inputsDigest",
      "tokenRef",
      "verdict",
    ]);
    expect(record.tokenRef).toBe(`file:${tokenPath}`);
    expect(record.inputsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.verdict).toBe("pass");
  });
});

describe("validation verdicts", () => {
  test("unparseable output is a failure (exit 1) carrying the raw line", async () => {
    const { result, exitCode } = await stamp({ verdict: "unparseable" });
    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.validation.verdict).toBe("unparseable");
    expect(result.validation.checks[0]?.raw).toBe("??? garbled status line");
    expect(result.error?.code).toBe("validation_failed");
    expect(result.human_steps).toEqual([]);
  });

  test("aggregation: any fail fails, else any unparseable, else pass; no checks is not a pass", () => {
    const c = (verdict: "pass" | "fail" | "unparseable") => ({ command: "c", exit_code: 0, verdict });
    expect(aggregateVerdict([c("pass"), c("pass")])).toBe("pass");
    expect(aggregateVerdict([c("pass"), c("unparseable")])).toBe("unparseable");
    expect(aggregateVerdict([c("unparseable"), c("fail")])).toBe("fail");
    expect(aggregateVerdict([])).toBe("fail");
  });
});

describe("identity in suite.json", () => {
  test("records refs, never values, and no .suite-state.json is written", async () => {
    const { result, writer } = await stamp({ needsValue: true });
    expect(result.ok).toBe(true);
    const identity = parseConfig(readFileSync(join(root, IDENTITY_FILE), "utf8"));
    expect(identity.tokenRef).toBe(`file:${tokenPath}`);
    expect(identity.runtimeId).toBe("fake-01a0d8f8-rt");
    expect(existsSync(join(root, ".suite-state.json"))).toBe(false);
    // The writer DID get the value in memory — so the clean scan below is meaningful.
    expect(writer.seen.tokenValue).toBe(token);
    expect(scanTexts({ seen: writer.seen.tokenValue ?? "" }, token).length).toBeGreaterThan(0);
    expect(scanTree(root, token)).toEqual([]);
  });

  test("a keychain ref records its service; switching back to file: drops it", async () => {
    const svc = "example-svc";
    const keychainRef = { tokenRef: "keychain:RUNTIME_TOKEN.fake", keychainService: svc };
    // Off darwin: refused before any write.
    const off = await stamp({}, keychainRef, "linux");
    expect(off.exitCode).toBe(2);
    expect(off.result.error?.message).toBe("keychain refs are macOS-only");
    expect(existsSync(root)).toBe(false);
    // On darwin, a writer that resolves the ref itself never runs security, and the service is recorded.
    const on = await stamp({ needsValue: false }, keychainRef, "darwin");
    expect(on.exitCode).toBe(0);
    expect(parseConfig(readFileSync(join(root, IDENTITY_FILE), "utf8")).keychainService).toBe(svc);
    await stamp({}, { tokenRef: `file:${tokenPath}` });
    expect(parseConfig(readFileSync(join(root, IDENTITY_FILE), "utf8")).keychainService).toBeUndefined();
    const cfg = { ...emptyConfig(), suiteUrl: "u", runtimeId: "r", tokenRef: "keychain:item", keychainService: svc };
    expect(parseConfig(serializeConfig(cfg))).toMatchObject({ tokenRef: "keychain:item", keychainService: svc });
  });

  test("a repair re-run with no --token-ref reuses the recorded ref", async () => {
    await stamp();
    const again = await stamp({}, { tokenRef: undefined, suiteUrl: undefined, runtimeId: undefined });
    expect(again.exitCode).toBe(0);
    expect(again.result.token_ref).toBe(`file:${tokenPath}`);
    expect(again.result.agent.runtime_id).toBe("fake-01a0d8f8-rt");
    expect(again.result.changed).toBe(false);
  });

  test("no ref given and none recorded is refused, naming --token-ref", async () => {
    const { exitCode, result } = await stamp({}, { tokenRef: undefined });
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("token_ref_required");
    expect(result.error?.message).toContain("--token-ref");
  });

  test("byte-identical inputs rewrite nothing: mtimes unchanged, changed:false", async () => {
    await stamp();
    const paths = [IDENTITY_FILE, STAMP_FILE, "fake-harness.json"].map((f) => join(root, f));
    const before = paths.map((p) => statSync(p).mtimeMs);
    await Bun.sleep(20);
    const { result } = await stamp();
    expect(result.changed).toBe(false);
    expect(result.actions.every((a) => a.outcome === "unchanged")).toBe(true);
    expect(paths.map((p) => statSync(p).mtimeMs)).toEqual(before);
  });

  test("an edited identity is repaired and reported as repaired", async () => {
    await stamp();
    const p = join(root, IDENTITY_FILE);
    writeFileSync(p, readFileSync(p, "utf8").replace("fake-01a0d8f8-rt", "edited-rt"));
    const { result } = await stamp();
    expect(result.actions.find((a) => a.kind === "identity")?.outcome).toBe("repaired");
    expect(result.changed).toBe(true);
  });

  test("operator headers in suite.json are refused (exit 2), naming the limitation", async () => {
    mkdirSync(root, { recursive: true });
    const cfg = { ...emptyConfig(), suiteUrl: "u", runtimeId: "r", headerNames: ["X-Example-Id"] };
    writeFileSync(join(root, IDENTITY_FILE), serializeConfig(cfg));
    const before = readFileSync(join(root, IDENTITY_FILE), "utf8");
    const { exitCode, result } = await stamp();
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("headers_unsupported");
    expect(result.error?.message).toContain("cannot forward extra headers");
    expect(readFileSync(join(root, IDENTITY_FILE), "utf8")).toBe(before);
  });

  test("a loosened token file is refused (exit 2) and nothing is written", async () => {
    chmodSync(tokenPath, 0o644);
    const { exitCode, result } = await stamp();
    expect(exitCode).toBe(2);
    expect(result.error?.message).toContain(tokenPath);
    expect(result.error?.message).toContain("0644");
    expect(existsSync(root)).toBe(false);
  });

  test("a root inside a git repo that does not ignore it is refused (exit 2)", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q", repo]);
    const { exitCode, result } = await stamp({}, { root: join(repo, "agent") });
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("write_refused");
    expect(existsSync(join(repo, "agent"))).toBe(false);
  });
});

describe("actions report what happened, and a failed stamp records fail", () => {
  const record = () => JSON.parse(readFileSync(join(root, STAMP_FILE), "utf8")) as { verdict: string };

  test("a failure part-way reports the unreached write as not applied, and records fail over an earlier pass", async () => {
    expect((await stamp()).exitCode).toBe(0);
    expect(record().verdict).toBe("pass");
    const { result, exitCode } = await stamp({ failApply: "after" }, { runtimeId: "fake-01a0d8f8-rt-2" });
    expect(exitCode).toBe(1);
    expect(result.error?.code).toBe("fake_failed");
    expect(result.actions.map((a) => [a.kind, a.target.split("/").pop(), a.outcome, a.applied])).toEqual([
      ["identity", "suite.json", "repaired", true],
      ["config_set", "fake-harness.json:account", "repaired", true],
      ["config_set", "fake-harness.json:second", "written", false],
      ["stamp_record", STAMP_FILE, "repaired", true],
    ]);
    expect(record().verdict).toBe("fail");
    expect(result.changed).toBe(true);
  });

  test("positive control: the same run without the failure applies every action and records pass", async () => {
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.actions.every((a) => a.applied)).toBe(true);
    expect(record().verdict).toBe("pass");
  });

  test("a failure before the writer wrote anything claims no harness write", async () => {
    const { result, exitCode } = await stamp({ failApply: "before" });
    expect(exitCode).toBe(1);
    const cs = result.actions.find((a) => a.kind === "config_set");
    expect(cs).toMatchObject({ outcome: "written", applied: false });
    expect(existsSync(join(root, FAKE_CONFIG))).toBe(false);
  });

  test("a harness install done before a refusal is reported and counts as a change; the root is untouched", async () => {
    const { result, exitCode } = await stamp({ installThenRefuse: true });
    expect(exitCode).toBe(2);
    expect(result.actions).toEqual([{ kind: "harness_install", target: "fake-harness@1.0.0", outcome: "written", applied: true }]);
    expect(result.changed).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test("a refusal before any write leaves an earlier pass record exactly as it was", async () => {
    expect((await stamp()).exitCode).toBe(0);
    const before = readFileSync(join(root, STAMP_FILE), "utf8");
    chmodSync(tokenPath, 0o644);
    const { exitCode } = await stamp();
    expect(exitCode).toBe(2);
    expect(readFileSync(join(root, STAMP_FILE), "utf8")).toBe(before);
  });
});

describe("config.ts never round-trips a literal", () => {
  test("parseConfig drops a tokenRef that is not a ref; serializeConfig refuses one", () => {
    const literal = canary();
    expect(parseConfig(JSON.stringify({ tokenRef: literal })).tokenRef).toBeUndefined();
    expect(() => serializeConfig({ ...emptyConfig(), tokenRef: literal })).toThrow();
  });

  test("an unset tokenRef leaves the serialised bytes as they were before this field", () => {
    expect(serializeConfig(emptyConfig())).not.toContain("tokenRef");
    expect(serializeConfig(emptyConfig())).not.toContain("keychainService");
  });
});
