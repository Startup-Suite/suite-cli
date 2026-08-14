/**
 * Credentials: how they are collected, how they are confirmed, and the single
 * sanctioned way to hand one to a child process.
 *
 * COLLECTION IS PASTE-IN. The user clicks Federate in the Suite UI and pastes
 * the values here. There is deliberately no device-code or OAuth flow: a later
 * `suite login` becomes one more Provider implementation and every consumer of
 * `CredentialStore.get`/`.set` keeps working unchanged.
 *
 * CONFIRMATION IS A COUNT. `set, 44 chars` — never a prefix, never a last-four
 * tail. A tail is still a partial echo, and a count already answers the only
 * question the user has: did my paste land whole.
 *
 * DELIVERY IS ARGV OR ENV, NEVER A SHELL, NEVER A COMMAND LINE THAT PERSISTS.
 * A process command line is world-readable through `ps` on every box. See
 * {@link spawnWithSecrets} and {@link assertNoSecretsInArgv}.
 */

/** Names the CLI itself knows about. Operator headers are keyed by their own name. */
export const TOKEN_KEY = "token";

export interface Credentials {
  /** Bearer token pasted from the Suite Federate UI. */
  token: string;
  /** Operator-specific extra headers, name → value. Values are secret. */
  headers: Record<string, string>;
}

export function emptyCredentials(): Credentials {
  return { token: "", headers: {} };
}

/**
 * The one place credentials are read from and written to. Stage 3 writes them
 * into the MCP entries; nothing else may reach around this interface.
 */
export interface CredentialStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  /** Every secret value currently held, for leak assertions. Never logged. */
  values(): string[];
}

export function createStore(initial: Credentials = emptyCredentials()): CredentialStore {
  const map = new Map<string, string>();
  if (initial.token !== "") map.set(TOKEN_KEY, initial.token);
  for (const [name, value] of Object.entries(initial.headers)) map.set(name, value);
  return {
    get: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    values: () => [...map.values()].filter((v) => v !== ""),
  };
}

/**
 * The confirmation line for a secret that was just captured.
 *
 * Deliberately contains no character of the value. Compare with a last-four
 * tail, which leaks four characters and a length, and is what this replaces.
 */
export function secretConfirmation(value: string): string {
  return `set, ${[...value].length} chars`;
}

/** Header values are bulleted, never shown, and confirmed the same way. */
export function maskValue(value: string): string {
  return "•".repeat(Math.min([...value].length, 8));
}

/* ------------------------------------------------------------------------- */
/* Prompting                                                                  */
/* ------------------------------------------------------------------------- */

export interface Prompter {
  /** Ask for a visible value (URL, runtime id, header NAME). */
  ask(question: string): Promise<string>;
  /** Ask for a secret. Implementations must not echo the typed characters. */
  askSecret(question: string): Promise<string>;
  /** Emit one line of output. */
  say(line: string): void;
}

/**
 * Collect the token, then loop for operator-specific headers.
 *
 * The loop hardcodes NO header names. Our own deployment happens to sit behind
 * a particular access proxy; another operator's sits behind a different one or
 * behind nothing. Baking one deployment's header names in as defaults or as
 * example text would make an accident of our infrastructure look like a
 * property of the tool.
 */
export async function solicitCredentials(
  prompter: Prompter,
  store: CredentialStore = createStore(),
): Promise<{ store: CredentialStore; headerNames: string[] }> {
  const token = (await prompter.askSecret("token (paste from Federate): ")).trim();
  store.set(TOKEN_KEY, token);
  prompter.say(`  token             ${secretConfirmation(token)}`);

  const headerNames = await solicitHeaders(prompter, store);
  return { store, headerNames };
}

export const HEADER_PROMPT = "any additional headers? (name: value, blank to finish): ";

/**
 * Prompt loop for extra headers. Returns the NAMES, which are config; the
 * values go into the store, which is not config.
 */
export async function solicitHeaders(
  prompter: Prompter,
  store: CredentialStore,
): Promise<string[]> {
  const names: string[] = [];
  for (;;) {
    const line = (await prompter.ask(HEADER_PROMPT)).trim();
    if (line === "") return names;
    const parsed = parseHeaderLine(line);
    if (parsed === null) {
      prompter.say("  expected  name: value");
      continue;
    }
    store.set(parsed.name, parsed.value);
    names.push(parsed.name);
    prompter.say(`  ${parsed.name}  ${maskValue(parsed.value)}  set`);
  }
}

export function parseHeaderLine(line: string): { name: string; value: string } | null {
  const at = line.indexOf(":");
  if (at <= 0) return null;
  const name = line.slice(0, at).trim();
  const value = line.slice(at + 1).trim();
  if (name === "" || value === "" || /[\s:]/.test(name)) return null;
  return { name, value };
}

/**
 * A Prompter backed by the real terminal. Secret input is read with the tty in
 * raw mode so nothing is echoed; off a tty it falls back to a plain read, which
 * is what a piped install script needs.
 */
export function ttyPrompter(): Prompter {
  const write = (s: string) => process.stdout.write(s);
  const stdin = process.stdin;

  /**
   * ONE reader for the life of the process, and it is never left.
   *
   * `process.stdin` is process-global and single-use. Leaving a `for await`
   * over it via `return` calls the iterator's `return()`, which DESTROYS the
   * stream; every later read then rejects immediately with `ABORT_ERR`. That
   * is invisible in any test that asks one question — and `suite init` asks at
   * least three — so the iterator is created once, held here, and pulled from
   * one line at a time.
   *
   * Bytes that arrive after a newline are kept in `buffered` for the NEXT
   * call. A terminal sends one line per chunk; a pipe happily delivers
   * "aaa\nbbb\nccc\n" as a single write, and dropping the tail of that chunk
   * would silently lose the answers to the following two questions.
   */
  let iterator: AsyncIterator<string | Uint8Array> | null = null;
  let buffered = "";
  let ended = false;

  const nextChunk = async (): Promise<string | null> => {
    if (ended) return null;
    if (iterator === null) iterator = stdin[Symbol.asyncIterator]() as AsyncIterator<string | Uint8Array>;
    const step = await iterator.next();
    if (step.done === true) {
      ended = true;
      return null;
    }
    const value = step.value;
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  };

  /** Apply the line-editing control characters to a run of input. */
  const edit = (text: string): string => {
    let out = "";
    for (const ch of text) {
      if (ch === "\x03") throw new Error("interrupted");
      if (ch === "\x7f" || ch === "\b") {
        out = out.slice(0, -1);
        continue;
      }
      out += ch;
    }
    return out;
  };

  /** A complete line from the buffer, or null when one has not arrived yet. */
  const takeBufferedLine = (): string | null => {
    for (let i = 0; i < buffered.length; i++) {
      const ch = buffered[i];
      if (ch === "\n" || ch === "\r") {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        // A CRLF pair is one terminator, not one line plus an empty one.
        if (ch === "\r" && buffered.startsWith("\n")) buffered = buffered.slice(1);
        return edit(line);
      }
    }
    return null;
  };

  const readLine = async (echo: boolean): Promise<string> => {
    const raw = !echo && stdin.isTTY === true;
    if (raw) stdin.setRawMode(true);
    try {
      for (;;) {
        const line = takeBufferedLine();
        if (line !== null) return line;
        const chunk = await nextChunk();
        if (chunk === null) {
          // EOF: whatever is left is the last, unterminated line.
          const rest = buffered;
          buffered = "";
          return edit(rest);
        }
        buffered += chunk;
      }
    } finally {
      if (raw) {
        stdin.setRawMode(false);
        write("\n");
      }
    }
  };
  return {
    async ask(question) {
      write(question);
      return (await readLine(true)).trim();
    },
    async askSecret(question) {
      write(question);
      return await readLine(false);
    },
    say: (line) => void process.stdout.write(`${line}\n`),
  };
}

/* ------------------------------------------------------------------------- */
/* Handing a secret to a child process                                        */
/* ------------------------------------------------------------------------- */

export class SecretInArgv extends Error {
  readonly index: number;
  constructor(index: number) {
    super(
      `argument ${index} contains a credential value; a command line is world-readable via ps. ` +
        `Pass it through the environment instead.`,
    );
    this.name = "SecretInArgv";
    this.index = index;
  }
}

/**
 * Throw if any element of `argv` contains a stored secret.
 *
 * Required for anything long-lived — a `tmux new-session` command line sits in
 * the process table for the life of the agent and is readable by every user on
 * the machine. That hazard did not exist when the launcher was a direct exec,
 * which is exactly why it needs an explicit check now.
 */
export function assertNoSecretsInArgv(argv: string[], store: CredentialStore): void {
  const secrets = store.values();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (secrets.some((s) => s.length > 0 && arg.includes(s))) throw new SecretInArgv(i);
  }
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Secret-bearing environment entries, merged last and never logged. */
  secretEnv?: Record<string, string>;
  /**
   * Allow secrets in argv. Only legitimate for a SHORT-LIVED, directly spawned
   * process (no shell, no shell history) such as `claude mcp add`. Never for
   * anything that stays in the process table.
   */
  allowSecretsInArgv?: boolean;
}

/**
 * The single sanctioned way to run a child process that needs a credential.
 *
 * - argv array, never a shell string: nothing reaches a shell, so nothing
 *   reaches shell history or word splitting.
 * - secrets default to the environment; putting one in argv requires opting in
 *   per call, which makes every such site greppable.
 * - the constructed command line is never logged, by this function or by any
 *   caller.
 */
export async function spawnWithSecrets(
  argv: string[],
  store: CredentialStore,
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  if (argv.length === 0) throw new Error("spawnWithSecrets requires a command");
  if (options.allowSecretsInArgv !== true) assertNoSecretsInArgv(argv, store);
  const env = { ...(options.env ?? process.env), ...(options.secretEnv ?? {}) } as Record<string, string>;
  const proc = Bun.spawn(argv, { cwd: options.cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
