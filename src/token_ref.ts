/**
 * Token references: the only way a stamp verb accepts the runtime token.
 *
 * ONE SYNTAX, shared with the OpenClaw channel plugin's resolver and with the
 * core installer's channel step, so a ref written by one is read by the others:
 *
 *   --token-ref file:<absolute path>
 *   --token-ref keychain:<item> --keychain-service <service>     (macOS only)
 *
 * A LITERAL VALUE IS REFUSED, in every spelling. `--token`, `--token=...`, a
 * `--token-ref` that is not one of the two prefixes, and a token piped on
 * stdin all exit 2. argv is readable by every user on the box through `ps`
 * and /proc/<pid>/cmdline, and "read it from stdin" invites `echo $TOKEN |`,
 * which is argv again one process earlier.
 *
 * A `file:` ref is VALIDATED BY STAT, NEVER BY READ. It must be a regular file
 * (not a symlink), owned by the caller, mode 0600 or 0400. A refusal names the
 * path and the mode it found; the content is never read, so it cannot be
 * printed.
 *
 * A `keychain:` ref is resolved with exactly
 *   /usr/bin/security find-generic-password -s <service> -a <item> -w
 * so argv carries NAMES only and the value arrives on the child's stdout, into
 * memory. The absolute path is deliberate: a `security` earlier on PATH must
 * not be able to answer for the keychain. Tests reach the fake through the
 * injectable {@link KeychainDeps.securityBin} seam, not through PATH.
 */
import { execFile } from "node:child_process";
import { fstatSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { EXIT_BLOCKED, EXIT_FAILED, StampFailure, refused, type HumanStep } from "./stamp_result.ts";

export const FILE_PREFIX = "file:";
export const KEYCHAIN_PREFIX = "keychain:";
export const SECURITY_BIN = "/usr/bin/security";

export type TokenRef =
  | { kind: "file"; path: string; raw: string }
  | { kind: "keychain"; item: string; service: string; raw: string };

const ARGV_READABLE = "argv is readable by every user through ps and /proc/<pid>/cmdline";

/** True when `value` is spelled as a ref. Says nothing about whether it resolves. */
export function isTokenRefString(value: string): boolean {
  return value.startsWith(FILE_PREFIX) || value.startsWith(KEYCHAIN_PREFIX);
}

export interface TokenRefFlags {
  tokenRef?: string;
  keychainService?: string;
  /** Every argument that is not one of ours, in order, `--` and after included. */
  rest: string[];
}

/**
 * Pull `--token-ref` and `--keychain-service` out of `args`, refusing any
 * literal-token flag on the way. Scanning stops at `--`: what follows belongs
 * to the harness and is passed through untouched.
 */
export function takeTokenRefFlags(args: string[]): TokenRefFlags {
  const rest: string[] = [];
  let tokenRef: string | undefined;
  let keychainService: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (arg === "--token" || arg.startsWith("--token=") || arg === "--token-stdin") {
      throw refused(
        "literal_token_refused",
        `${arg.split("=")[0]} is refused: ${ARGV_READABLE}. Pass --token-ref file:<absolute path> ` +
          `(mode 0600) or --token-ref keychain:<item> --keychain-service <service>.`,
      );
    }
    const [flag, inline] = splitFlag(arg);
    if (flag === "--token-ref" || flag === "--keychain-service") {
      const value = inline ?? args[i + 1];
      if (inline === undefined) i++;
      if (value === undefined || value === "") throw refused("flag_value_missing", `${flag} needs a value`);
      if (flag === "--token-ref") tokenRef = value;
      else keychainService = value;
      continue;
    }
    rest.push(arg);
  }
  return { tokenRef, keychainService, rest };
}

function splitFlag(arg: string): [string, string | undefined] {
  const at = arg.indexOf("=");
  return at > 0 && arg.startsWith("--") ? [arg.slice(0, at), arg.slice(at + 1)] : [arg, undefined];
}

/**
 * Parse a ref string. Anything that is not a well-formed `file:` or
 * `keychain:` ref is refused as a literal — and the refusal does NOT repeat
 * the string, because a literal is exactly the case where it is a secret.
 */
export function parseTokenRef(raw: string, options: { keychainService?: string } = {}): TokenRef {
  if (raw === "-" || raw === "stdin" || raw.startsWith("stdin:")) {
    throw refused("stdin_token_refused", `a token on stdin is refused. ${refHint()}`);
  }
  if (raw.startsWith(FILE_PREFIX)) {
    const path = raw.slice(FILE_PREFIX.length);
    if (!isAbsolute(path)) {
      throw refused("token_ref_invalid", `file: refs need an absolute path, got ${JSON.stringify(path)}`);
    }
    return { kind: "file", path, raw };
  }
  if (raw.startsWith(KEYCHAIN_PREFIX)) {
    const item = raw.slice(KEYCHAIN_PREFIX.length);
    if (item === "") throw refused("token_ref_invalid", "keychain: refs need an item name");
    if (!isValidItem(item)) {
      throw refused(
        "token_ref_invalid",
        `keychain item ${JSON.stringify(item)} contains whitespace or a control character; an item is one plain word`,
      );
    }
    const service = options.keychainService ?? "";
    if (service === "") {
      throw refused("keychain_service_missing", `keychain:${item} needs --keychain-service <service>`);
    }
    return { kind: "keychain", item, service, raw };
  }
  const scheme = unknownScheme(raw);
  if (scheme !== null) {
    throw refused("token_ref_unknown_scheme", `unknown token ref scheme ${JSON.stringify(scheme)}. ${refHint()}`);
  }
  throw refused(
    "literal_token_refused",
    `--token-ref takes a reference, not a value; a literal is refused because ${ARGV_READABLE}. ${refHint()}`,
  );
}

/**
 * A keychain item is one plain word: non-empty, no whitespace, no control
 * character. spec/token-ref.md, "Syntax".
 */
export function isValidItem(item: string): boolean {
  return item !== "" && !/[\s\x00-\x1f\x7f]/.test(item);
}

/**
 * The scheme of a string that LOOKS like a ref but is not one of ours, e.g.
 * `env:` or `Keychain:`, or null. Runtime tokens are url-safe base64 and never
 * contain `:`, so this cannot catch a real token. Only the scheme is returned:
 * the rest of the string is not repeated anywhere.
 */
export function unknownScheme(raw: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
  if (m === null) return null;
  const scheme = `${m[1]}:`;
  return scheme === FILE_PREFIX || scheme === KEYCHAIN_PREFIX ? null : scheme;
}

function refHint(): string {
  return "Use --token-ref file:<absolute path> (mode 0600) or --token-ref keychain:<item> --keychain-service <service>.";
}

export interface FileRefDeps {
  /** The caller's uid. Injected so the foreign-owner branch is testable without root. */
  uid?: number;
}

/** Octal mode string, e.g. `0644`. */
export function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/**
 * Refuse a `file:` ref unless it is a regular file, owned by the caller, mode
 * 0600 or 0400. By stat only: the content is never read here.
 */
export function checkFileRef(path: string, deps: FileRefDeps = {}): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw refused("token_file_missing", `token file ${path} does not exist or cannot be stat'ed`);
  }
  if (!st.isFile()) {
    throw refused("token_file_not_regular", `token file ${path} is not a regular file (symlinks are refused)`);
  }
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  if (st.uid !== uid) {
    throw refused("token_file_foreign_owner", `token file ${path} is owned by uid ${st.uid}, not by the caller (uid ${uid})`);
  }
  const perm = st.mode & 0o777;
  if (perm !== 0o600 && perm !== 0o400) {
    throw refused(
      "token_file_mode",
      `token file ${path} has mode ${modeString(st.mode)}; it must be 0600 or 0400. ` +
        `The CLI does not chmod an operator's file.`,
    );
  }
}

export interface KeychainDeps {
  platform?: NodeJS.Platform;
  /** Absolute path of `security`. Only tests change it. */
  securityBin?: string;
  /** Runs `bin` with `args`, no shell. Injected for tests that want no child at all. */
  exec?: (bin: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>;
}

export type ResolveDeps = FileRefDeps & KeychainDeps;

/**
 * Everything that can be decided about a ref without reading a secret: the
 * file's owner and mode, and whether this platform has a keychain at all.
 * Called before any write, so a bad ref leaves nothing behind.
 */
export function validateTokenRef(ref: TokenRef, deps: ResolveDeps = {}): void {
  if (ref.kind === "file") {
    checkFileRef(ref.path, deps);
    return;
  }
  if ((deps.platform ?? process.platform) !== "darwin") {
    throw refused("keychain_unsupported_platform", "keychain refs are macOS-only");
  }
}

/** The argv of the keychain read. Names only; pinned by test. */
export function securityArgs(ref: { item: string; service: string }): string[] {
  return ["find-generic-password", "-s", ref.service, "-a", ref.item, "-w"];
}

function execFileNoShell(bin: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolveP, reject) => {
    execFile(bin, args, { encoding: "utf8", shell: false }, (error, stdout) => {
      if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
        reject(error);
        return;
      }
      const code = error === null ? 0 : ((error as { code: number }).code ?? 1);
      resolveP({ exitCode: code, stdout: String(stdout) });
    });
  });
}

function stripOneNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

/**
 * Resolve a ref to its value, IN MEMORY. The caller hands it to a child on a
 * stdin pipe, or does not need it at all when the harness resolves the ref
 * itself. Never log, print, serialise or put the return value in argv/env of
 * a long-lived process.
 */
export async function resolveTokenRef(ref: TokenRef, deps: ResolveDeps = {}): Promise<string> {
  validateTokenRef(ref, deps);
  if (ref.kind === "file") {
    const value = stripOneNewline(readFileSync(ref.path, "utf8"));
    if (value === "") throw refused("token_file_empty", `token file ${ref.path} is empty`);
    return value;
  }
  const exec = deps.exec ?? execFileNoShell;
  let r: { exitCode: number; stdout: string };
  try {
    r = await exec(deps.securityBin ?? SECURITY_BIN, securityArgs(ref));
  } catch (e) {
    throw new StampFailure(EXIT_FAILED, "keychain_exec_failed", `could not run ${deps.securityBin ?? SECURITY_BIN}: ${(e as Error).name}`);
  }
  const value = r.exitCode === 0 ? stripOneNewline(r.stdout) : "";
  if (value === "") {
    const text =
      `The keychain did not return item ${JSON.stringify(ref.item)} of service ${JSON.stringify(ref.service)} ` +
      `(security exit ${r.exitCode}). Unlock the login keychain, or add the item, then re-run.`;
    throw new StampFailure(EXIT_BLOCKED, "keychain_unavailable", text, [keychainHumanStep(ref, r.exitCode)]);
  }
  return value;
}

/** `security` exits 44 (errSecItemNotFound) when there is no such item. */
export const SECURITY_EXIT_ITEM_NOT_FOUND = 44;

/** Apple's Keychain Access guide: the official page for both keychain steps. */
export const KEYCHAIN_HELP_URL = "https://support.apple.com/guide/keychain-access/welcome/mac";

/**
 * What a human does about a keychain read that returned nothing. Exit 44 is
 * "no such item": the item has to be added, which `suite secret put` does
 * (value on stdin). Anything else is a locked keychain or a session that may
 * not show the unlock prompt (an ssh login gets exit 36): unlock it.
 */
export function keychainHumanStep(ref: { item: string; service: string }, securityExit: number): HumanStep {
  if (securityExit === SECURITY_EXIT_ITEM_NOT_FOUND) {
    return {
      kind: "keychain_item_missing",
      text: `The keychain has no item ${JSON.stringify(ref.item)} in service ${JSON.stringify(ref.service)}. Add it (the value is read from stdin), then re-run.`,
      command: `suite secret put --keychain-service ${ref.service} --item ${ref.item}`,
      url: KEYCHAIN_HELP_URL,
    };
  }
  return {
    kind: "keychain_unlock",
    text: `The login keychain is locked, or this session may not show the unlock prompt (security exit ${securityExit}). Unlock it, then re-run.`,
    command: "security unlock-keychain ~/Library/Keychains/login.keychain-db",
    url: KEYCHAIN_HELP_URL,
  };
}

export type StdinState = "tty" | "none" | "idle" | "data";

/**
 * What is on stdin, without keeping any of it.
 *
 * `tty` and `none` (a /dev/null or empty file) are fine. `data` means someone
 * piped something in, which a stamp refuses. A pipe that is open but silent
 * (`idle`) is how most programmatic callers spawn a child, so it is allowed:
 * refusing it would make every `execFile` caller a failure.
 */
export async function probeStdin(timeoutMs = 150): Promise<StdinState> {
  if (process.stdin.isTTY === true) return "tty";
  let st: ReturnType<typeof fstatSync>;
  try {
    st = fstatSync(0);
  } catch {
    return "none";
  }
  if (st.isCharacterDevice()) return "none";
  if (st.isFile()) return st.size > 0 ? "data" : "none";
  const reader = Bun.stdin.stream().getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read().then((r) => (r.done === true || (r.value?.length ?? 0) === 0 ? "none" : "data")),
      new Promise<"idle">((res) => {
        timer = setTimeout(() => res("idle"), timeoutMs);
      }),
    ]);
    return first as StdinState;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

/** Refuse a stamp whose stdin carries data. */
export function refuseStdinData(state: StdinState): void {
  if (state === "data") {
    throw refused("stdin_token_refused", `input on stdin is refused; a stamp never reads a token from stdin. ${refHint()}`);
  }
}
