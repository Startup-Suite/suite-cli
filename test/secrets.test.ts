import { describe, expect, test } from "bun:test";
import {
  HEADER_PROMPT,
  SecretInArgv,
  TOKEN_KEY,
  assertNoSecretsInArgv,
  createStore,
  maskValue,
  parseHeaderLine,
  secretConfirmation,
  solicitCredentials,
  spawnWithSecrets,
  type Prompter,
} from "../src/secrets.ts";

/* Invented values only — this repository is public. */
const TOKEN = "tok_wjq4vn8x2m6r0k5p9d3f7h1s4a8e2c6b0y9u";
const HEADER_NAME = "X-Example-Gateway-Id";
const HEADER_VALUE = "gw_11111111111111111111111111111111";

/** A scripted Prompter that records every question asked and line printed. */
function fakePrompter(answers: string[], secrets: string[] = []): Prompter & {
  asked: string[];
  printed: string[];
} {
  const asked: string[] = [];
  const printed: string[] = [];
  return {
    asked,
    printed,
    async ask(question) {
      asked.push(question);
      return answers.shift() ?? "";
    },
    async askSecret(question) {
      asked.push(question);
      return secrets.shift() ?? "";
    },
    say: (line) => void printed.push(line),
  };
}

describe("secret confirmation", () => {
  test("reads as a count and nothing else", () => {
    expect(secretConfirmation("a".repeat(44))).toBe("set, 44 chars");
  });

  test("contains no character sequence from the value — not even a tail", () => {
    const line = secretConfirmation(TOKEN);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(TOKEN.slice(-4));
    expect(line).not.toContain(TOKEN.slice(0, 4));
    expect(line).not.toContain("…");
  });

  test("header values render as bullets, never characters", () => {
    const masked = maskValue(HEADER_VALUE);
    expect(masked).toMatch(/^•+$/);
    expect(HEADER_VALUE).not.toContain(masked);
  });
});

describe("credential solicitation", () => {
  test("no output line contains any substring of the supplied token", async () => {
    const prompter = fakePrompter([`${HEADER_NAME}: ${HEADER_VALUE}`, ""], [TOKEN]);
    const { store, headerNames } = await solicitCredentials(prompter);

    expect(store.get(TOKEN_KEY)).toBe(TOKEN);
    expect(store.get(HEADER_NAME)).toBe(HEADER_VALUE);
    expect(headerNames).toEqual([HEADER_NAME]);

    const output = [...prompter.printed, ...prompter.asked].join("\n");
    for (let len = 4; len <= TOKEN.length; len++) {
      expect(output).not.toContain(TOKEN.slice(0, len));
      expect(output).not.toContain(TOKEN.slice(TOKEN.length - len));
    }
    for (let len = 4; len <= HEADER_VALUE.length; len++) {
      expect(output).not.toContain(HEADER_VALUE.slice(0, len));
    }
    expect(prompter.printed.join("\n")).toContain(secretConfirmation(TOKEN));
  });

  test("the header loop terminates on a blank line and hardcodes no names", async () => {
    const prompter = fakePrompter([""], [TOKEN]);
    const { headerNames } = await solicitCredentials(prompter);
    expect(headerNames).toEqual([]);
    expect(prompter.asked).toContain(HEADER_PROMPT);
    // The prompt names no header: which headers a deployment needs is the
    // operator's business, not the tool's.
    expect(HEADER_PROMPT).toMatch(/^any additional headers\?/);
  });

  test("a malformed header line is re-prompted rather than accepted", async () => {
    const prompter = fakePrompter(["nonsense", `${HEADER_NAME}: ${HEADER_VALUE}`, ""], [TOKEN]);
    const { headerNames } = await solicitCredentials(prompter);
    expect(headerNames).toEqual([HEADER_NAME]);
    expect(prompter.printed).toContain("  expected  name: value");
  });

  test("header lines split on the first colon only", () => {
    expect(parseHeaderLine("X-A: b: c")).toEqual({ name: "X-A", value: "b: c" });
    expect(parseHeaderLine("nocolon")).toBeNull();
    expect(parseHeaderLine(": value")).toBeNull();
    expect(parseHeaderLine("X-A:")).toBeNull();
    expect(parseHeaderLine("bad name: v")).toBeNull();
  });
});

describe("secrets never reach a command line", () => {
  test("an argv element containing a stored secret is rejected", () => {
    const store = createStore({ token: TOKEN, headers: { [HEADER_NAME]: HEADER_VALUE } });
    expect(() =>
      assertNoSecretsInArgv(["tmux", "new-session", "-d", `TOKEN=${TOKEN}`], store),
    ).toThrow(SecretInArgv);
    expect(() => assertNoSecretsInArgv(["tmux", "new-session", HEADER_VALUE], store)).toThrow(
      SecretInArgv,
    );
  });

  test("a clean argv passes", () => {
    const store = createStore({ token: TOKEN, headers: {} });
    expect(() => assertNoSecretsInArgv(["tmux", "new-session", "-s", "proj"], store)).not.toThrow();
  });

  test("an empty store cannot make every argument look like a secret", () => {
    const store = createStore();
    store.set(TOKEN_KEY, "");
    expect(() => assertNoSecretsInArgv(["anything", "at", "all"], store)).not.toThrow();
  });

  test("spawnWithSecrets refuses the argv path by default and delivers via env", async () => {
    const store = createStore({ token: TOKEN, headers: {} });
    await expect(spawnWithSecrets(["/bin/echo", TOKEN], store)).rejects.toThrow(SecretInArgv);

    const result = await spawnWithSecrets(["/bin/sh", "-c", 'printf %s "$SUITE_TOKEN"'], store, {
      secretEnv: { SUITE_TOKEN: TOKEN },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(TOKEN);
  });

  test("argv is passed as an array, so nothing is word-split or shell-expanded", async () => {
    const store = createStore();
    const result = await spawnWithSecrets(["/bin/echo", "two words", "$HOME"], store);
    expect(result.stdout).toBe("two words $HOME\n");
  });

  test("the argv opt-out exists for short-lived direct spawns only", async () => {
    const store = createStore({ token: TOKEN, headers: {} });
    const result = await spawnWithSecrets(["/bin/echo", TOKEN], store, {
      allowSecretsInArgv: true,
    });
    expect(result.exitCode).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */
/* ttyPrompter — sequential reads off the process-global stdin                */
/* ------------------------------------------------------------------------- */

/**
 * These run the prompter in a CHILD process because that is the only place the
 * defect exists: `process.stdin` is process-global and single-use, and the
 * previous implementation destroyed it by leaving a `for await` via `return`.
 *
 * Both tests ask THREE questions. One question always worked, which is why the
 * defect shipped; two is the minimum that can detect it and three is what
 * `suite init` actually needs (suite url, runtime id, token).
 */
const PROMPTER_FIXTURE = new URL("./prompter-fixture.ts", import.meta.url).pathname;

async function drivePrompter(writes: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", PROMPTER_FIXTURE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const chunk of writes) {
    proc.stdin.write(chunk);
    proc.stdin.flush();
    await Bun.sleep(60);
  }
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stderr.trim() !== "") throw new Error(`prompter fixture wrote to stderr: ${stderr}`);
  return { exitCode, stdout };
}

function answers(stdout: string): string[] {
  // The prompt text shares the line with the answer that follows it, so match
  // rather than anchoring at the start of the line.
  return [...stdout.matchAll(/answer:(.*)/g)].map((m) => m[1] ?? "");
}

describe("ttyPrompter reads more than once", () => {
  test("three questions asked one at a time all get their own answer", async () => {
    const { exitCode, stdout } = await drivePrompter(["aaa\n", "bbb\n", "ccc\n"]);
    expect(stdout).not.toContain("error:");
    expect(answers(stdout)).toEqual(["aaa", "bbb", "ccc"]);
    expect(exitCode).toBe(0);
  }, 20_000);

  test("lines delivered in ONE chunk are buffered, not discarded", async () => {
    const { exitCode, stdout } = await drivePrompter(["aaa\nbbb\nccc\n"]);
    expect(stdout).not.toContain("error:");
    expect(answers(stdout)).toEqual(["aaa", "bbb", "ccc"]);
    expect(exitCode).toBe(0);
  }, 20_000);
});
