import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  DEFAULT_SESSION_NAMING,
  emptyConfig,
  parseConfig,
  readConfig,
  serializeConfig,
  writeConfig,
  type SuiteConfig,
} from "../src/config.ts";
import {
  DEFAULT_SCOPE,
  WriteRefused,
  assertWritable,
  configDir,
  configPath,
  dataDir,
  gitProbe,
} from "../src/paths.ts";
import { createStore, TOKEN_KEY } from "../src/secrets.ts";

/* Invented values only — this repository is public. */
const SUITE_URL = "https://suite.example.invalid";
const RUNTIME_ID = "runtime_00000000-0000-0000-0000-000000000000";
const TOKEN = "tok_wjq4vn8x2m6r0k5p9d3f7h1s4a8e2c6b0y9u";
const HEADER_NAME = "X-Example-Gateway-Id";
const HEADER_VALUE = "gw_11111111111111111111111111111111";

const scratches: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "suite-cli-cfg-"));
  scratches.push(dir);
  return dir;
}

async function scratchRepo(gitignore: string): Promise<string> {
  const dir = await scratch();
  Bun.spawnSync(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  await writeFile(resolve(dir, ".gitignore"), gitignore);
  return dir;
}

afterEach(async () => {
  while (scratches.length > 0) {
    const dir = scratches.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

function fullConfig(): SuiteConfig {
  return {
    suiteUrl: SUITE_URL,
    runtimeId: RUNTIME_ID,
    headerNames: [HEADER_NAME],
    sessionNaming: "cwd",
  };
}

describe("config paths", () => {
  test("user scope is the default scope", () => {
    expect(DEFAULT_SCOPE).toBe("user");
  });

  test("XDG_CONFIG_HOME wins, HOME/.config is the fallback", () => {
    expect(configDir({ HOME: "/home/nobody", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/suite");
    expect(configDir({ HOME: "/home/nobody" })).toBe("/home/nobody/.config/suite");
    expect(configPath({ HOME: "/home/nobody" })).toBe("/home/nobody/.config/suite/config.json");
    expect(dataDir({ HOME: "/home/nobody" })).toBe("/home/nobody/.local/share/suite");
  });

  test("a relative XDG_CONFIG_HOME is ignored rather than trusted", () => {
    expect(configDir({ HOME: "/home/nobody", XDG_CONFIG_HOME: "relative/path" })).toBe(
      "/home/nobody/.config/suite",
    );
  });
});

describe("the config file holds no secret", () => {
  test("serialized bytes contain neither the token nor any header value", async () => {
    const store = createStore();
    store.set(TOKEN_KEY, TOKEN);
    store.set(HEADER_NAME, HEADER_VALUE);

    const dir = await scratch();
    const target = resolve(dir, "config.json");
    await writeConfig(fullConfig(), { path: target });

    const bytes = await Bun.file(target).text();
    expect(bytes).toContain(SUITE_URL);
    expect(bytes).toContain(RUNTIME_ID);
    expect(bytes).toContain(HEADER_NAME); // the NAME is config
    expect(bytes).not.toContain(HEADER_VALUE); // the VALUE is not
    expect(bytes).not.toContain(TOKEN);
    for (const secret of store.values()) expect(bytes).not.toContain(secret);
  });

  test("serialisation whitelists keys, so a stray secret field cannot leak", () => {
    const smuggled = { ...fullConfig(), token: TOKEN, headers: { [HEADER_NAME]: HEADER_VALUE } };
    const text = serializeConfig(smuggled as SuiteConfig);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(HEADER_VALUE);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "suiteUrl",
      "runtimeId",
      "headerNames",
      "sessionNaming",
    ]);
  });

  test("round-trips through parse unchanged", () => {
    expect(parseConfig(serializeConfig(fullConfig()))).toEqual(fullConfig());
    expect(emptyConfig().sessionNaming).toBe(DEFAULT_SESSION_NAMING);
  });

  test("readConfig returns null when nothing has been written", async () => {
    const dir = await scratch();
    expect(await readConfig({ path: resolve(dir, "config.json") })).toBeNull();
  });
});

describe("the gitignore guard", () => {
  test("NEGATIVE: inside a git repo, not ignored — refused, nothing written", async () => {
    const repo = await scratchRepo("# nothing ignored\n");
    const target = resolve(repo, "suite", "config.json");

    let refusal: unknown;
    try {
      await writeConfig(fullConfig(), { path: target });
    } catch (e) {
      refusal = e;
    }

    expect(refusal).toBeInstanceOf(WriteRefused);
    const err = refusal as WriteRefused;
    expect(err.path).toBe(target);
    expect(err.message).toContain(target);
    expect(err.exitCode).not.toBe(0);
    // No file, and not even the directory: the refusal precedes every mkdir.
    expect(await Bun.file(target).exists()).toBe(false);
    expect(await readdir(repo)).not.toContain("suite");
  });

  test("POSITIVE CONTROL: same repo, target ignored — the write proceeds", async () => {
    // Load-bearing: a guard that refuses unconditionally passes the negative
    // case above. Only this case can tell a correct guard from a broken one.
    const repo = await scratchRepo("suite/\n");
    const target = resolve(repo, "suite", "config.json");

    await writeConfig(fullConfig(), { path: target });

    expect(await Bun.file(target).exists()).toBe(true);
    expect(await Bun.file(target).text()).toContain(RUNTIME_ID);
  });

  test("a target outside any git repo proceeds", async () => {
    const dir = await scratch();
    const target = resolve(dir, "nested", "config.json");
    expect(gitProbe.repoRoot(target)).toBeNull();
    await writeConfig(fullConfig(), { path: target });
    expect(await Bun.file(target).exists()).toBe(true);
  });

  test("a nested .gitignore is honoured, which hand-parsing would miss", async () => {
    const repo = await scratchRepo("# root ignores nothing\n");
    await mkdir(resolve(repo, "sub"), { recursive: true });
    await writeFile(resolve(repo, "sub", ".gitignore"), "config.json\n");
    const nested = resolve(repo, "sub", "config.json");
    expect(() => assertWritable(nested)).not.toThrow();
    expect(() => assertWritable(resolve(repo, "sub", "other.json"))).toThrow(WriteRefused);
  });
});
