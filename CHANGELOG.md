# Changelog

Notable changes to the `suite` CLI. Newest first.

The version in `package.json` is the single source of truth — `suite --version`,
the POSIX launcher and `install.sh`'s banner all read it. **Bump it in the same
PR as the change**, so that an installed CLI's version answers the only question
that matters in the field: is this one newer than what I had?

Minor for a new capability or a changed default; patch for a fix that changes no
behaviour anyone was relying on.

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
