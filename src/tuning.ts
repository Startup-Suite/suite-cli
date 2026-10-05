/**
 * Tuning values, in ONE place, so they can change without touching logic.
 *
 * Each is a number someone may want to move after watching it run (task
 * 01a0d6b9 declares this work not experimentable: it is local plumbing with no
 * user-facing decision point to split and measure, so the knobs live here
 * instead). The Mac app keeps its own copy of the two it polls with; the
 * values here are the CLI's side of the same agreement.
 */

/** How long a machine caller (the Mac app) waits for one `suite ... --json` verb. */
export const CLI_TIMEOUT_MS = 15_000;

/** How often the Mac app's menu re-reads `suite status --json`. Read by the app, documented here. */
export const STATUS_POLL_INTERVAL_MS = 60_000;

/**
 * How long `suite secret` waits for `/usr/bin/security`. Measured on rock
 * (2026-10-05): with HOME pointed somewhere that has no login keychain,
 * `security -i add-generic-password` does not fail, it WAITS (for a keychain
 * to be created through UI that an ssh session cannot show). A machine caller
 * must get a document, not a hang, so the child is killed at this limit.
 */
export const SECURITY_TIMEOUT_MS = 10_000;

/** The authenticated `tools/list` probe `suite init --token-ref` makes before it saves anything. */
export const CREDENTIAL_PROBE_TIMEOUT_MS = 10_000;

/** Crash-loop guard for the watchdog's restore pass (stage 2): at most this many restarts... */
export const CRASH_LOOP_MAX_RESTARTS = 3;

/** ...per agent in this window. */
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;

/**
 * How long `suite mcp-headers` may spend resolving the ref. Claude Code kills a
 * headersHelper after 10 s (code.claude.com/docs/en/mcp, "headersHelper"), so
 * this stays under it and the helper fails with a named error instead.
 */
export const MCP_HEADERS_TIMEOUT_MS = 8_000;

/** How long `suite harness` waits for one `<harness> --version` / login-status probe. */
export const HARNESS_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long `suite login` lets a harness's own login run before giving up on it.
 * Codex's device code lives 15 minutes (measured, codex-cli 0.157.0); a person
 * finishing a browser sign-in needs no longer than that either.
 */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;

/**
 * How long `suite login claude --no-browser` waits for Claude Code to hand its
 * localhost-callback URL to the browser shim. Measured on rock: well under a
 * second. Past this, the caller is told to finish in a terminal instead.
 */
export const LOGIN_BROWSER_WAIT_MS = 20_000;
