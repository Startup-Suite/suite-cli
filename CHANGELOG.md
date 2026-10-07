# Changelog

Notable changes to the `suite` CLI. Newest first.

The version in `package.json` is the single source of truth — `suite --version`,
the POSIX launcher and `install.sh`'s banner all read it. **Bump it in the same
PR as the change**, so that an installed CLI's version answers the only question
that matters in the field: is this one newer than what I had?

Minor for a new capability or a changed default; patch for a fix that changes no
behaviour anyone was relying on.

## 0.7.2

- **dsh `usage_event` names the task and stage it belongs to.** The
  suite-federation plugin now sends top-level `task_id` (from the dispatch
  signal, falling back to `context.task.id`) and `metadata.stage_id` (the plan
  stage whose status is `running`). Core matches usage reports to dispatches
  on those two keys; without them every dsh agent's client-side token and turn
  figures were unattributable. A dispatch with no task (a plain mention) sends
  null for both, never an invented id.

## 0.7.1

- **The connection is per agent folder, not per machine.** Through 0.7.0,
  `suite init` saved ONE connection per machine, so `suite init` in a second
  agent folder silently re-pointed the first: the next `suite claude` there
  treated its own MCP entries as stale and rewrote them with the other agent's
  runtime, URL and token. Now `suite init` saves the connection for one folder
  (the working directory, or `--dir PATH`) under
  `~/.config/suite/agents/<key>.json` plus a 0600 `.credentials.json`, outside
  the folder. `suite init` in folder B cannot change folder A's bytes.
- **The legacy machine connection is assigned to no folder.** A 0.7.0
  `config.json` / `credentials.json` connection is still read and reported
  (`suite status` prints it as `legacy`), but it is never written, deleted or
  used to identify or wire a folder. **Re-run `suite init` (or
  `suite init --from-mcp-json`) in each agent folder after upgrading.** Until
  then, `suite claude` in a folder that has Claude entries and no record
  leaves the entries as they are, registers nothing and says so; in a folder
  with neither, it asks the init questions when it has a terminal.
- **Existing entries are repaired when the agent is next started, not by
  `init`.** `suite init --from-mcp-json` alone does not rewrite a folder's local
  Claude entries; `suite init` never runs `claude`. Once a folder has a record,
  the next `suite claude` there, or the next `suite restore` that starts that
  folder's agent, compares the entries with the record and rewrites the ones
  that differ. `suite restore` now does that before replaying each `claude`
  roster entry. It skips an agent whose session is already live, and does not
  rewire it.
- **`suite init --from-mcp-json`** adopts the folder's own `.mcp.json`, so no
  token passes through an argv, a shell or a terminal. It refuses, naming fields
  and never values, when the entries are missing, name different hosts, or carry
  different tokens.
- **`suite doctor` has an `agents` check.** It fails on any cross-wired agent
  folder on the machine, where the record, the local Claude entry and
  `.mcp.json` name different runtimes or hosts, and on any user-scope Suite
  entry. It names the folder and the runtime ids, reads `~/.claude.json`
  directly, never runs `claude mcp get/list`, and writes nothing. Its `install`
  check reads this folder's record.
- **`suite status` lists every agent folder** with its runtime and install,
  from the same inventory as `--json`, so both count the same agents. A folder
  wired only by its Claude entries is listed as `(unrecorded — run suite init)`.
- **An unwired `suite claude` names the folder** it could not connect, and
  where to run `suite init`; so do the `suite codex` and `suite deepseek`
  refusals.
  **`suite status --json [--dir PATH]`** prints one document,
  `contract_version` 1, with `connection`, `legacy_connection` and an `agents`
  row per agent (`session`, `kind`, `root`, `runtime_id`, `suite_url`, `state`,
  `channel`, `verdict`, `recorded`, `wiring`). No token value or token field
  appears, and no row takes its runtime id from the legacy connection. See the
  README's status contract.
- **`suite watch` telemetry events carry `runtime_id`** from the event's folder
  record, or null.

## 0.7.0

- **`suite codex`: a Codex agent in Suite, through `codex app-server`.** It
  reuses the saved install connection, or asks for it inline. When Codex is
  not logged in, it runs Codex's own `codex login --device-auth`, which needs
  no browser on the host. It gives Codex the install's MCP tools plus a
  `suite-channel` server with `suite_reply`, `suite_typing`,
  `suite_reply_chunk` and `suite_reply_with_media`, as `-c` overrides, so no
  config file is edited and no token is in an argv. Each Suite space maps to
  one persistent Codex thread, which is resumed after a restart. Approval
  requests follow `--approvals accept|decline` (default `accept`, the parity
  of `suite claude`'s `--dangerously-skip-permissions`). It runs under the same
  tmux, restore and watchdog supervision as `suite claude`. `CODEX_HOME`
  defaults to `<root>/.codex`.
- **`suite restore` and `suite status` know the `codex` kind**, and adoption
  recognises a running `suite codex` bridge.

## 0.6.1

- **Agents come back with nobody at the keyboard.** Claude Code shows a
  full-screen "Loading development channels" warning on every launch with
  `--dangerously-load-development-channels`, and in a new folder it first asks
  whether the folder is trusted. Until someone answered, a restarted or
  rebooted agent sat there alive and silent. `suite claude` and `suite restore`
  now watch each session they start for up to 60 seconds and answer those
  dialogs — plus the bypass-permissions acceptance and the "New MCP server
  found" prompt (answered "Continue without", never an approval). `suite watch`
  answers one still on screen in a session it owns, as a backstop.
- **Only screens known word for word.** A dialog is answered only when its
  whole text matches the screen captured from Claude Code 2.1.288 (kept as test
  fixtures), with the folder it names being the folder the agent was launched
  in and the channel being `server:suite-channel` alone. The key depends on
  where the cursor is: two of these dialogs default to "No, exit". A reworded
  or unknown dialog gets no keys and one log line saying so.
- **Every key is logged** to `~/.local/state/suite/sessions/<session>.log`, and
  each tmux call targets the session by exact name (`=NAME:`), never a prefix.

## 0.6.0

- **`suite init` is harness-neutral.** It connects the machine to a Suite
  install and does nothing else: it checks `bun` and `tmux`, saves the URL,
  runtime id and token, and installs the watchdog. It no longer clones the
  Claude channel plugin, runs `claude mcp add` or writes `CLAUDE.md`. Before
  this, on a machine without Claude Code (a fresh Mac, or a DeepSeek-only box),
  init died at `claude mcp add` with `ENOENT: claude`.
- **`suite claude` does its own wiring.** Before each launch it clones the
  channel plugin if it is absent, writes `CLAUDE.md` if there is none, and
  registers each MCP entry that is missing or no longer matches the saved
  connection. It uses the saved connection and does not ask for credentials
  again. A folder that is already wired runs no `git`, `bun` or `claude mcp`.
  An existing plugin checkout is no longer pulled. Re-running init used to
  update it; update it with `git -C ~/.local/share/suite/claude-code-suite-channel pull`.
- **No chicken-and-egg.** `suite claude`, or `suite deepseek` from a terminal,
  on a machine with no saved connection now asks the init questions itself
  (URL, runtime id, token) and saves the answers. It no longer says "run suite
  init first". Off a terminal, `suite claude` warns and starts Claude without
  Suite wiring, which is what it did before. `suite deepseek` refuses as before.
- **The token is saved** in `~/.config/suite/credentials.json`, mode 600, next
  to `config.json`, so any harness verb can reuse it. Before this the only copy
  was inside Claude's MCP entries. A machine set up by 0.5.x is asked for its
  token once, and only if an entry has to be rewritten. With `--token-from-env
  VAR`, only the name is saved (config `tokenEnv`).
- **`suite deepseek` finds the token `suite init` saved.** Before this it read
  `state.json`, which init never wrote, so it always failed with "no runtime
  token found" unless the agent root had its own state file.
- **`suite doctor` reports two halves.** The install connection (`install`,
  `tmux`) comes first, then the claude harness. A missing, moved or unreadable
  Claude entry now points at `suite claude`. A rejected credential still points
  at `suite init`.
- `suite init --checkout` is accepted and ignored, with a note saying so.
- `suite hermes` and `suite openclaw` are unchanged. They take their identity
  from flags and the agent root's `suite.json`, and never depended on init.

## 0.5.1

- **`suite deepseek` works from the agent's folder.** `cd ~/agents/oddjob &&
  suite deepseek` now uses that folder's own `suite.json` and
  `.suite-state.json`, as `--root` does. Before this it fell back to the machine
  config and said to run `suite init`. When the agent's session is live the
  command attaches to it, and when the session is stale it is recycled, as
  `suite claude` does. `--root` still takes precedence. A parent directory of
  an agent root is not treated as that agent.
- **`suite deepseek` passes the agent's `env` block to the harness.**
  The `env` in `<root>/.suite-state.json` (`OPENROUTER_API_KEY`, `DSH_MODEL`,
  `DSH_PERMISSION_MODE`, ...) was never read. dsh therefore started without its
  model key, connected, and failed every turn with `MISSING_CREDENTIAL`. Those
  values now go into the environment only, and the argv guard covers them. The
  agent's values override both the inherited environment and the defaults. The
  patch declares the model that `DSH_MODEL` selects, so choosing a model other
  than the default no longer fails with `UNKNOWN_MODEL`. The command now warns
  when the OpenRouter route has no key.

## 0.5.0

- **`suite init` registers the MCP entries per agent directory, not per
  machine.** Both `suite-channel` and `startup-suite` are now added at local
  scope, from the agent directory. They used to be added at user scope, which
  is one entry shared by every Claude on the machine, so installing a second
  agent replaced the first agent's entries with the second one's Suite and
  runtime. On a real host that meant an agent's next restart would have
  federated into the other install as the other runtime. Nothing is written
  into the agent directory; the entries live in the mode-600 `~/.claude.json`
  under the directory's key. `init` never removes or rewrites a user-scope
  entry, because another agent may still depend on it. It warns when that entry
  names a different runtime, and this directory's own entry takes precedence
  here. A re-run replaces only this directory's entries. Agents that relied on
  the old user-scope entry keep working until you run `suite init` in their
  directory.

- **A new agent's first `suite claude` stays up again.** `suite claude` injects
  `--continue`, and in a directory with no conversation Claude exits 1 with "No
  conversation found to continue". The earlier retry (PR #21) ran from `suite
  claude` when the session was dead 1.5 s after launch, but Claude's development-channels warning
  (and, in a new directory, the workspace-trust prompt) keeps the process alive
  until it is answered. So the retry never fired, `suite claude` printed
  "started …", and the agent exited as soon as the dialog was accepted. The
  fallback now runs in the pane itself: `/bin/sh -c` runs claude with
  `--continue`, and if that exits non-zero it `exec`s claude without it. The
  relaunch shows the development-channels warning again, so a new agent asks
  for it twice. The
  argv still reaches claude as positional parameters and is never parsed as
  shell text. It does not retry after exit 0, after death by signal, or when the
  first run lasted 5 minutes or more, because a continued conversation that
  exits non-zero after that long has crashed, and restarting it fresh would drop
  the conversation without saying so. The restore roster records the wrapped
  command, and `suite restore --adopt` adopts the claude process under the
  shell, not the shell.

## 0.4.0

- **`suite hermes` and `suite openclaw`: stamp a Hermes or OpenClaw agent root
  Suite-ready, then run its gateway in a persistent tmux session.** Each agent's
  harness state lives under its root, never in `~/.hermes` or `~/.openclaw`,
  and neither verb installs, starts or restarts a daemon. The runtime token is
  accepted only by reference (`--token-ref file:<path>` or
  `--token-ref keychain:<item> --keychain-service <svc>`); a literal is refused.
- **`suite hermes` stamps a lean toolset for the Suite platform by default.**
  It sets `platform_toolsets.startup_suite: [hermes-webhook]` (web, vision and
  clarify, plus every enabled MCP server, so the Suite bridge stays) and no
  other toolset key. The reasons: a channel agent's capabilities come through
  the Suite MCP bundle, shell and file tools widen what untrusted chat can
  reach, and Hermes's own default makes the first prompt 16,633 tokens, which
  a 16K-context model cannot answer. `--full-toolset` opts out, removing the
  key only when it holds exactly that lean list. An operator's own value is
  never overwritten.
- **Stamp results report what happened, not what was planned.** Each action
  carries `applied`; a failed run lists the writes it never reached as
  `applied: false`, and a harness install that ran before a refusal is still
  listed. A run that fails after its first write records `fail` in
  `.suite-stamp.json`, so `suite status` and `--gateway-only` never act on an
  older `pass`.
- **A signalled gateway wrapper takes its gateway down.** The session exec
  forwards SIGTERM and SIGHUP (and SIGINT when no terminal delivered it) to the
  child and waits for it, instead of leaving it orphaned.
- **`--stamp-only` is a stable machine contract** for callers such as core's
  installer `setup channel` step: one JSON document on stdout
  (`contract_version: 1`, additive changes only), and exit codes 0 ok, 1 failed,
  2 refused, 3 blocked on a human. The README's "Stamp contract" section is the
  reference, and a test keeps it in step with what the code emits.
- **`suite status` lists stamped agents** with kind, root, session state and the
  last stamp verdict. A gateway that died takes its tmux session with it, so a
  recorded agent that is not running reads `stale`, not absent. Sessions of
  other kinds are now checked for their own process (`dsh`, `hermes`,
  `openclaw-gateway`), so they are no longer reported as a dead Claude.
- **The restore roster records `hermes` and `openclaw` agents**, and
  `suite restore --adopt` recognises their gateway sessions.

## 0.3.0

- **`suite init` no longer leaves an agent without the conventions just because
  the repo ships its own `CLAUDE.md`.** That filename carries two different
  documents — an agent's brief and a project's codebase guide — and `exists`
  cannot tell them apart, so in most mature repos `init` skipped, printed
  `present, left alone`, and the agent received none of the conventions with
  nothing saying so. An existing `CLAUDE.md` is still **never** written to.
  Instead the conventions go to `SUITE_CONVENTIONS.md`, a file the CLI owns
  outright and rewrites on every run, and `init` names what the existing file is
  missing plus the one line (`@SUITE_CONVENTIONS.md`) that loads it. A
  `CLAUDE.md` that already states the conventions gets no second file.

## 0.2.0

- **`suite init` seeds a starting `CLAUDE.md`** for new Suite agents — how a
  runtime is expected to behave on the platform, distilled from the briefs
  already in use. An existing file is never overwritten; a re-run reports
  `present, left alone`. The template is static and carries no identifiers.
- **Sessions are created with tmux mouse mode on**, scoped to the session and
  never `-g`. Without it, tmux turns a wheel event inside a full-screen app into
  arrow keys, so scrolling an agent walks its input history instead of its
  scrollback. New sessions only — reattaching never re-configures a session you
  are already working in. Note mouse mode also routes click-drag to tmux's
  selection, so a native selection needs the terminal's override modifier
  (Option on macOS).
- `--session` is wired through, so the flag the README documents exists.

## 0.1.0

First tagged version: `init`, `claude`, `doctor`, `status`, `update`, the POSIX
launcher and `install.sh`.
