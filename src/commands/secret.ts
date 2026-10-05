/**
 * `suite secret put|delete` — the ONLY keychain writers a machine caller (the
 * Mac app) runs.
 *
 *   suite secret put    --keychain-service SVC --item NAME     value on stdin
 *   suite secret delete --keychain-service SVC --item NAME
 *
 * THE VALUE NEVER TOUCHES AN ARGV. `put` reads it from stdin (refusing a TTY,
 * where it would be typed visibly, and an empty value) and hands it to
 * `/usr/bin/security -i`, whose commands arrive on ITS stdin. The value is
 * written hex-encoded (`-X`), so no quoting rule of `security`'s interactive
 * parser can split or mangle it, and no character of it is ever a shell word.
 *
 * WHY /usr/bin/security AND NOT A KEYCHAIN API. An item's access list trusts
 * the application that CREATED it ("By default, the application which creates
 * an item is trusted to access its data without warning" — `security
 * add-generic-password -h`, measured on rock, macOS 26.3). Every later reader of
 * the item — `suite`, both channel plugins — reads it with
 * `/usr/bin/security find-generic-password`, the same binary, so none of them
 * meets an access prompt.
 *
 * `put` then READS THE ITEM BACK through the same resolver every consumer uses
 * and compares sha256 in memory. It prints one JSON document:
 * `{contract_version, ok, service, item, sha256_prefix, error, human_steps}`.
 * The prefix is 12 hex characters of sha256(value): enough for a caller to
 * confirm the item it wrote is the item it meant, and nothing else.
 *
 * A LOCKED KEYCHAIN IS A HUMAN STEP, NOT A FAILURE. Over ssh the login
 * keychain refuses a write with exit 36 (`User interaction is not allowed`,
 * -25308; measured on rock 2026-10-05). That exits 3 with a `keychain_unlock`
 * step, the same contract as `suite init`.
 */
import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import { CONTRACT_VERSION, EXIT_BLOCKED, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, StampFailure, divertStdout, refused, type HumanStep, type StampIO } from "../stamp_result.ts";
import { SECURITY_BIN, isValidItem, keychainHumanStep, resolveTokenRef, type KeychainDeps } from "../token_ref.ts";
import { SECURITY_TIMEOUT_MS } from "../tuning.ts";

/** Runs `bin` with `args` and `stdin` piped in, no shell. Output is captured and never printed. */
export type SecurityExec = (bin: string, args: string[], stdin?: string) => Promise<{ exitCode: number; stdout: string }>;

export interface SecretDeps {
  platform?: NodeJS.Platform;
  securityBin?: string;
  exec?: SecurityExec;
  /** The value on stdin, or a refusal reason. Injected so tests need no real stdin. */
  readStdin?: () => Promise<{ tty: true } | { tty: false; value: string }>;
}

export interface SecretResult {
  contract_version: typeof CONTRACT_VERSION;
  ok: boolean;
  action: "put" | "delete";
  service: string;
  item: string;
  /** `put`: 12 hex of sha256(value) as read back. Null on failure. */
  sha256_prefix: string | null;
  /** `delete`: whether an item was there to delete. */
  deleted?: boolean;
  human_steps: HumanStep[];
  error: { code: string; message: string } | null;
}

export const SHA256_PREFIX_LENGTH = 12;

export function sha256Prefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, SHA256_PREFIX_LENGTH);
}

/** A service or item is one plain word: the spec's item rule, plus no quote or backslash. */
export function isPlainName(name: string): boolean {
  return isValidItem(name) && !/["'\\]/.test(name);
}

export interface SecretOptions {
  action: "put" | "delete";
  service: string;
  item: string;
}

/** Parse `secret put|delete` arguments. Literal value flags are refused, never read. */
export function parseSecretArgs(args: string[]): SecretOptions {
  const [action, ...rest] = args;
  if (action !== "put" && action !== "delete") {
    throw refused("secret_action_unknown", "usage: suite secret put|delete --keychain-service SVC --item NAME");
  }
  let service = "";
  let item = "";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === "--value" || flag === "--password" || flag === "-w" || flag === "--token") {
      throw refused("literal_secret_refused", `${flag} is refused: argv is readable by every user through ps. Pipe the value on stdin.`);
    }
    if (flag === "--keychain-service" || flag === "--item") {
      const value = eq > 0 ? arg.slice(eq + 1) : rest[i + 1];
      if (eq <= 0) i++;
      if (value === undefined || value === "") throw refused("flag_value_missing", `${flag} needs a value`);
      if (flag === "--item") item = value;
      else service = value;
      continue;
    }
    // Not repeated: an unexpected positional may be the value someone typed.
    throw refused("unknown_argument", "suite secret: unexpected argument (not repeated here, in case it is a value)");
  }
  if (service === "") throw refused("keychain_service_missing", "--keychain-service SVC is required");
  if (item === "") throw refused("item_missing", "--item NAME is required");
  if (!isPlainName(service)) throw refused("token_ref_invalid", `keychain service ${JSON.stringify(service)} must be one plain word`);
  if (!isPlainName(item)) throw refused("token_ref_invalid", `keychain item ${JSON.stringify(item)} must be one plain word`);
  return { action, service, item };
}

/** The one line `security -i` reads. Names, then the value as hex. Never logged. */
export function addCommandLine(service: string, item: string, value: string): string {
  const hex = Buffer.from(value, "utf8").toString("hex");
  return `add-generic-password -U -s "${service}" -a "${item}" -X ${hex}\n`;
}

/** argv of the delete: names only. */
export function deleteArgs(service: string, item: string): string[] {
  return ["delete-generic-password", "-s", service, "-a", item];
}

function stripOneNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

/** What liveExec reports when `security` had to be killed at {@link SECURITY_TIMEOUT_MS}. */
export const SECURITY_TIMED_OUT = -2;

async function liveExec(bin: string, args: string[], stdin?: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn([bin, ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, SECURITY_TIMEOUT_MS);
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: timedOut ? SECURITY_TIMED_OUT : exitCode, stdout: timedOut ? "" : stdout };
  } finally {
    clearTimeout(timer);
  }
}

async function liveReadStdin(): Promise<{ tty: true } | { tty: false; value: string }> {
  if (process.stdin.isTTY === true) return { tty: true };
  try {
    if (fstatSync(0).isCharacterDevice()) return { tty: false, value: "" };
  } catch {
    return { tty: false, value: "" };
  }
  return { tty: false, value: await Bun.stdin.text() };
}

function result(action: SecretOptions["action"], service = "", item = ""): SecretResult {
  return { contract_version: CONTRACT_VERSION, ok: false, action, service, item, sha256_prefix: null, human_steps: [], error: null };
}

/** A failed keychain write, as a human step when a human can fix it. */
function writeFailure(service: string, item: string, exitCode: number): StampFailure {
  // Exit 36 (-25308, errSecInteractionNotAllowed) is a locked keychain in a
  // session that may not prompt: what ssh gets (measured on rock, 2026-10-05).
  if (exitCode === 36 || exitCode === SECURITY_TIMED_OUT) {
    const step = keychainHumanStep({ service, item }, exitCode);
    return new StampFailure(EXIT_BLOCKED, "keychain_locked", step.text, [step]);
  }
  return new StampFailure(EXIT_FAILED, "keychain_write_failed", `security could not write item ${JSON.stringify(item)} of service ${JSON.stringify(service)} (exit ${exitCode})`);
}

/**
 * Run `suite secret`. Returns the result and its exit code; prints nothing.
 * `secrets` lists the value(s) held, so the renderer can redact as a last line.
 */
export async function runSecretInner(args: string[], deps: SecretDeps = {}): Promise<{ result: SecretResult; exitCode: number; secrets: string[] }> {
  const action = args[0] === "delete" ? "delete" : "put";
  let res = result(action);
  const secrets: string[] = [];
  try {
    const opts = parseSecretArgs(args);
    res = result(opts.action, opts.service, opts.item);
    if ((deps.platform ?? process.platform) !== "darwin") {
      throw refused("keychain_unsupported_platform", "suite secret writes the macOS keychain; there is none on this platform");
    }
    const bin = deps.securityBin ?? SECURITY_BIN;
    const exec = deps.exec ?? liveExec;

    if (opts.action === "delete") {
      const r = await exec(bin, deleteArgs(opts.service, opts.item));
      if (r.exitCode !== 0 && r.exitCode !== 44) throw writeFailure(opts.service, opts.item, r.exitCode);
      res.ok = true;
      res.deleted = r.exitCode === 0;
      return { result: res, exitCode: EXIT_OK, secrets };
    }

    const input = await (deps.readStdin ?? liveReadStdin)();
    if (input.tty) {
      throw refused("stdin_is_tty", "suite secret put reads the value from a pipe, never a terminal (it would echo)");
    }
    const value = stripOneNewline(input.value);
    if (value === "") throw refused("secret_empty", "no value on stdin");
    secrets.push(value);

    const w = await exec(bin, ["-i"], addCommandLine(opts.service, opts.item, value));
    if (w.exitCode !== 0) throw writeFailure(opts.service, opts.item, w.exitCode);

    // Read back through the resolver every consumer uses, compare in memory.
    const keychainDeps: KeychainDeps = { platform: "darwin", securityBin: bin, exec: (b, a) => exec(b, a) };
    const back = await resolveTokenRef({ kind: "keychain", item: opts.item, service: opts.service, raw: `keychain:${opts.item}` }, keychainDeps);
    secrets.push(back);
    if (sha256Prefix(back) !== sha256Prefix(value) || back !== value) {
      throw new StampFailure(EXIT_FAILED, "keychain_readback_mismatch", `item ${JSON.stringify(opts.item)} read back different from what was written`);
    }
    res.ok = true;
    res.sha256_prefix = sha256Prefix(back);
    return { result: res, exitCode: EXIT_OK, secrets };
  } catch (e) {
    const f = e instanceof StampFailure ? e : new StampFailure(EXIT_FAILED, "internal", e instanceof Error ? e.name : "error");
    res.ok = false;
    res.error = { code: f.code, message: f.message };
    res.human_steps.push(...f.humanSteps);
    return { result: res, exitCode: f.exitCode === EXIT_REFUSED ? EXIT_REFUSED : f.exitCode, secrets };
  }
}

export function renderSecretResult(r: SecretResult, secrets: readonly string[]): string {
  let text = `${JSON.stringify(r, null, 2)}\n`;
  for (const s of secrets) if (s !== "") text = text.split(s).join("[redacted]");
  return text;
}

/** `suite secret ...` entry point: exactly one JSON document on stdout. */
export async function runSecret(args: string[], deps: SecretDeps = {}, io?: StampIO): Promise<number> {
  const go = async (sink: StampIO): Promise<number> => {
    const { result: r, exitCode, secrets } = await runSecretInner(args, deps);
    if (r.error !== null) sink.stderr(`suite: ${r.error.message}\n`);
    sink.stdout(renderSecretResult(r, secrets));
    return exitCode;
  };
  return io !== undefined ? await go(io) : await divertStdout(go);
}
