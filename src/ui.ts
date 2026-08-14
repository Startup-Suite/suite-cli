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
