/**
 * Terminal output primitives shared by every verb.
 *
 * The design direction is a single two-column grid — fixed-width label column,
 * value column, faint detail trailing — so every verb reads as one program.
 * Colour is never the sole carrier of meaning, NO_COLOR is honoured, and no
 * SGR bytes are emitted when stdout is not a TTY, so `suite doctor > file`
 * produces a clean file.
 */

export const LABEL_WIDTH = 18;

export function colorEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return isTTY;
}

/* ------------------------------------------------------------------------- */
/* Colour and glyphs                                                          */
/* ------------------------------------------------------------------------- */

/**
 * SGR codes, from the terminal's own 16-colour semantic slots.
 *
 * NOT brand hex, deliberately (design canvas revision 1). We do not control the
 * terminal background; the user's theme does, and it has already solved
 * contrast against it. `#06D5ED` on a light background is 1.8:1 — unreadable.
 * Cyan is decoration only and never carries state.
 */
export const SGR = {
  reset: "[0m",
  faint: "[2m",
  bold: "[1m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
} as const;

/** Wrap `text` in an SGR code, or return it untouched when colour is off. */
export function paint(text: string, code: string, color: boolean): string {
  if (!color || text === "") return text;
  return `${code}${text}${SGR.reset}`;
}

/**
 * Is it safe to print `✔ ✘ ⋯`? Only under a UTF-8 locale; elsewhere those bytes
 * render as mojibake of unpredictable width, which breaks the label column the
 * whole layout rests on.
 */
export function utf8Enabled(env: Record<string, string | undefined> = process.env): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(locale);
}

export type CheckStatus = "pass" | "fail" | "skip";

/**
 * The status glyph. ASCII fallback is `ok` / `X` / `-`, padded to the SAME
 * width as the UTF-8 form so the two columns to its right do not move.
 */
export const GLYPH_WIDTH = 2;

export function glyphFor(status: CheckStatus, utf8: boolean): string {
  const table = utf8
    ? { pass: "✔", fail: "✘", skip: "⋯" }
    : { pass: "ok", fail: "X", skip: "-" };
  return table[status].padEnd(GLYPH_WIDTH, " ");
}

export function row(label: string, value = "", detail = ""): string {
  const cell = label.padEnd(LABEL_WIDTH, " ");
  return `  ${cell}${value}${detail ? `  ${detail}` : ""}`.trimEnd();
}

/**
 * The next command a user should run. Zero indent, alone on its line, so it
 * survives a double-click without dragging leading whitespace.
 */
export function nextCommand(command: string): string {
  return command;
}
