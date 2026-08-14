import { describe, expect, test } from "bun:test";
import { parse, run, usage } from "../src/cli.ts";
import { row, nextCommand, colorEnabled, LABEL_WIDTH } from "../src/ui.ts";

describe("verb dispatch", () => {
  test("recognises each verb", () => {
    expect(parse(["init"]).verb).toBe("init");
    expect(parse(["doctor"]).verb).toBe("doctor");
    expect(parse(["status"]).verb).toBe("status");
    expect(parse(["claude"]).verb).toBe("claude");
  });

  test("claude new is the single explicit force-new form", () => {
    const d = parse(["claude", "new", "--resume"]);
    expect(d.verb).toBe("claude new");
    expect(d.args).toEqual(["--resume"]);
  });

  test("passes user arguments through verbatim and in order", () => {
    const args = ["--resume", "two words", "it's \"quoted\"", "$HOME", "--", "-p"];
    expect(parse(["claude", ...args]).args).toEqual(args);
  });

  test("an unknown command exits non-zero", () => {
    expect(parse(["nope"]).verb).toBe(null);
    expect(run(["nope"])).toBe(2);
  });

  test("--version and --help exit 0", () => {
    expect(run(["--version"])).toBe(0);
    expect(run(["--help"])).toBe(0);
  });
});

describe("output primitives", () => {
  test("row pads the label column to a fixed width", () => {
    expect(row("bun", "1.2.4")).toBe(`  ${"bun".padEnd(LABEL_WIDTH)}1.2.4`);
  });

  test("the next command carries zero indent", () => {
    expect(nextCommand("suite init")).toBe("suite init");
  });

  test("usage ends with the next command at zero indent", () => {
    const lines = usage().split("\n").filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1] ?? "";
    expect(last).toBe("suite init");
    expect(last).toBe(last.trimStart());
  });

  test("NO_COLOR disables colour even on a TTY", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });
});
