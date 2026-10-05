/**
 * `suite mcp-headers [--token-ref REF] [--keychain-service SVC]` — HIDDEN.
 *
 * Claude Code's `headersHelper` for the `startup-suite` HTTP MCP entry in ref
 * mode. Claude runs it (through a shell, with a 10 s limit) at session start
 * and on reconnect, and reads ONE JSON object of string pairs from its stdout:
 *
 *   {"Authorization":"Bearer <token>", "<operator header>":"<value>", ...}
 *
 * That object is the ONLY place the token is ever written by this CLI, and it
 * goes to stdout, for Claude Code alone. Nothing is logged: not the value, not
 * a length, not a prefix. A failure is one stderr line naming the ref, and a
 * non-zero exit, which Claude reports as a failed connection.
 *
 * The ref comes from the flags the wiring wrote into the helper command, so a
 * folder keeps resolving its OWN ref even if the machine connection later
 * changes; without flags it falls back to the machine connection.
 *
 * Claude runs a local-scope helper WITHOUT credential-named environment
 * variables (anything with TOKEN, SECRET, KEY, AUTH...), so the ref itself is
 * passed as an argument, not through the environment. A ref is a name, not a
 * secret.
 */
import { readConfig } from "../config.ts";
import { readCredentials } from "../connection.ts";
import { EXIT_FAILED, StampFailure, refused } from "../stamp_result.ts";
import { parseTokenRef, resolveTokenRef, takeTokenRefFlags, type ResolveDeps } from "../token_ref.ts";
import { MCP_HEADERS_TIMEOUT_MS } from "../tuning.ts";

type Env = Record<string, string | undefined>;

export interface McpHeadersDeps {
  env: Env;
  resolve?: ResolveDeps;
  stdout(text: string): void;
  stderr(text: string): void;
  timeoutMs?: number;
}

/** Build the headers object. Pure apart from the ref resolution and two file reads. */
export async function mcpHeaders(args: string[], deps: McpHeadersDeps): Promise<Record<string, string>> {
  const { tokenRef, keychainService, rest } = takeTokenRefFlags(args);
  if (rest.length > 0) throw refused("unknown_argument", "suite mcp-headers takes only --token-ref and --keychain-service");
  const config = await readConfig({ env: deps.env });
  const refString = tokenRef ?? config?.tokenRef;
  if (refString === undefined || refString === "") {
    throw refused("token_ref_required", "no token ref: pass --token-ref, or connect this machine with suite init --token-ref");
  }
  const service = keychainService ?? (tokenRef === undefined ? config?.keychainService : undefined);
  const ref = parseTokenRef(refString, { keychainService: service });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StampFailure(EXIT_FAILED, "mcp_headers_timeout", `resolving ${ref.raw} took longer than ${deps.timeoutMs ?? MCP_HEADERS_TIMEOUT_MS} ms`)),
      deps.timeoutMs ?? MCP_HEADERS_TIMEOUT_MS,
    );
  });
  let token: string;
  try {
    token = await Promise.race([resolveTokenRef(ref, deps.resolve), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const headers: Record<string, string> = {};
  const saved = readCredentials(deps.env);
  for (const name of config?.headerNames ?? []) {
    const v = saved?.headers[name];
    if (v !== undefined && v !== "") headers[name] = v;
  }
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Run the verb: the object on stdout, or one named line on stderr. */
export async function runMcpHeaders(args: string[], deps: McpHeadersDeps): Promise<number> {
  try {
    deps.stdout(`${JSON.stringify(await mcpHeaders(args, deps))}\n`);
    return 0;
  } catch (e) {
    // StampFailure messages name refs, items, services and paths only.
    if (e instanceof StampFailure) {
      deps.stderr(`suite mcp-headers: ${e.message}\n`);
      return e.exitCode;
    }
    deps.stderr(`suite mcp-headers: ${e instanceof Error ? e.name : "error"}\n`);
    return 1;
  }
}
