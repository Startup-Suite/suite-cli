```
                _ _
  ___ _   _ _(_) |_ ___
 / __| | | | | | __/ _ \
 \__ \ |_| | | | ||  __/
 |___/\__,_|_|_|\__\___|
```

# suite-cli

`suite` wires a Claude Code runtime to [Startup Suite](https://github.com/Startup-Suite)
in one command instead of eight manual steps, and keeps agents alive when the
terminal that started them goes away.

macOS and Linux. **Windows is not supported** — the installer refuses it by
name rather than failing obscurely.

## Before you start

<a id="before-you-start"></a>

`suite` never runs a package manager and never uses `sudo`, so these are
**checked and named**, never installed for you. Install any that are missing
with your own package manager first:

* `git` — clones the Suite channel plugin during `suite init`.
* `curl` — fetches this installer, and the bun installer if you take that route.
* `ca-certificates` — without trusted roots every one of those fetches fails at
  TLS rather than at a prompt.
* `tar` — unpacks what the installer downloads.
* `unzip` — what **bun's official installer**
  (`curl -fsSL https://bun.sh/install | bash`) needs: it downloads a zip release
  and unpacks it. `suite` **checks for `unzip` and will not install it** — that
  would mean a package manager, which means root, and this tool has no `sudo`
  path at all. Without it you get a named refusal (`unzip is needed to install
  bun, and is not on PATH`) before anything is downloaded, not a half-written
  bun. If your distro packages `bun` directly, `suite init` takes that route
  instead and needs no `unzip`.

### Claude Code is installed on demand, not up front

<a id="claude-on-demand"></a>

**Claude Code is not a prerequisite.** Nothing above installs it and `suite
init` does not ask about it. The first time you launch an agent with `suite
claude`, if `claude` is not on `PATH`, `suite` says so, **offers to install it**
with the official installer (`curl -fsSL https://claude.ai/install.sh | bash`,
which lands a launcher in `~/.local/bin` and needs no `sudo`), and — once it is
in place — carries straight on into the run you asked for.

**Declining installs nothing and exits non-zero.** So do an unknown platform, a
missing `curl` or `bash`, a failing installer, and an installer that claims
success without leaving a binary: each prints what is missing and stops. There
is no half-installed state to clean up.

**Logging in is still your step.** `suite` installs a binary and never touches
your Anthropic credentials — running `claude` opens the browser login, and the
offer says so before you answer it.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Startup-Suite/suite-cli/main/install.sh | sh
```

The installer never uses `sudo`. It installs to `$XDG_BIN_HOME`, or
`~/.local/bin` when that is unset, tells you if that directory is not on your
`PATH`, and prints the exact `export PATH=` line to add. If a `suite` is
already installed it names the version it would replace and asks first.

## Wire this machine up

```sh
suite init
```

`init` detects `bun` and `tmux` (offering to install either, never unasked),
clones the channel plugin, asks for your credentials, and registers both MCP
entries — then health-checks that they actually **connect**, because written is
not connected.

### It also seeds a `CLAUDE.md`

`init` writes a starting `CLAUDE.md` into the working directory: a short brief
on how an agent is expected to behave on this platform. It covers the
conventions a new agent gets wrong by default — **a task assignment is already
the authorization** so there is nothing to wait for, a terminal-only answer is
an answer nobody received so substantive replies go through `suite_reply`, spawn
a subagent before you ack, never self-approve a human gate, and prefer org
memory over local notes.

**An existing `CLAUDE.md` is never overwritten.** The file is yours the moment
it exists, and `init` is re-run routinely — losing the operating knowledge an
agent has accumulated there would be the worst thing this verb could do. A
re-run reports `present, left alone` and touches nothing.

### ...and if that file is a project's, not an agent's

Two different documents share the filename: an agent's brief, and a *project's*
codebase guide. Most mature repos ship the second one, and `init` cannot tell
them apart — so a skip used to mean the agent got **none** of the conventions,
silently.

When your `CLAUDE.md` exists and states none of them, `init` leaves it alone and
writes `SUITE_CONVENTIONS.md` beside it — a file the CLI **owns and rewrites on
every run**, so keep your own notes in `CLAUDE.md`. It then prints what is
missing and the single line that loads it:

```
@SUITE_CONVENTIONS.md
```

A `CLAUDE.md` that already states the conventions, or that already loads that
file, gets no second copy and no nagging.

The template is static and carries no identifiers — no tokens, no runtime ids,
no hostnames — because it lands in a directory that may well be a git repo.

## Run an agent

```sh
suite claude
```

That is the whole daily loop. Claude Code runs inside a `tmux` session named
for this directory, so **closing the terminal does not kill the agent**; run it
again from the same place and you are back in the same session.

## Commands

| Command | What it does |
| --- | --- |
| `suite init` | Detects `bun` and `tmux`, installs the channel plugin, collects credentials, registers both MCP entries and verifies they connect |
| `suite claude [...]` | Runs Claude Code in the persistent session for this directory; re-attaches when one is already live. Every argument passes through verbatim |
| `suite claude new [...]` | **The force-new verb.** Creates a second session even when one exists, under the next free name (`…-2`) |
| `suite claude -p '…'` | One-shot, non-interactive: **bypasses tmux entirely** and execs Claude directly |
| `suite claude --session NAME` | Per-invocation override of the derived session name. The one option the wrapper owns; not persisted |
| `suite claude -- …` | `--` terminates wrapper options; everything after it is Claude's, including the literal word `new` |
| `suite deepseek [...]` | Runs a DeepSeek Harness agent federated into Suite. Installs the harness on demand; every argument after ours passes through to `dsh` |
| `suite deepseek --root DIR` | The agent's root folder — its cwd, its `DSH_HOME`, and where a per-agent identity may live |
| `suite hermes --root DIR [...]` | Stamps a Hermes agent root and runs its gateway in tmux. See [`suite hermes`](#suite-hermes) |
| `suite openclaw --root DIR [...]` | Stamps an OpenClaw agent root and runs its gateway in tmux. See [`suite openclaw`](#suite-openclaw) |
| `suite hermes\|openclaw --stamp-only` | Stamps only, and prints one JSON document. See [the stamp contract](#stamp-contract---stamp-only) |
| `suite update` | Re-runs the installer to replace this install with the latest published CLI |
| `suite doctor` | Diagnoses a broken setup — one runnable remedy per failure, and a stale session is never reported green |
| `suite status` | Shows which runtime this box is federated as, the state and age of each session, and each stamped agent's kind, root, state and last verdict |
| `suite --version`, `suite --help` | Version, and the verb list |

### What `suite doctor` checks that nothing else does

Most of a broken setup announces itself. Two states do not, and both are why
this command exists.

**Registered, reachable and authenticated are three different claims.** An MCP
entry can be registered, its endpoint can answer, and its credential can still
be refused — and from the Claude side that last one is *invisible*: the server
loads, `claude mcp list` shows it, and it simply exposes no tools. It presents
as silence, not as an error. So `tools api` makes a real authenticated
`tools/list` call and asserts a non-empty tool list. It also keeps apart the two
ways that call can fail, because they need opposite fixes: a JSON-RPC refusal
from Suite itself is the *credential*, while an HTML login page from something
in front of Suite means the request never reached the application at all and the
credential was never evaluated.

**Both entries should carry one credential.** `suite-channel` keeps it in
`SUITE_TOKEN`, `startup-suite` in an `Authorization: Bearer` header. When both
point at the same Suite host and the two values differ, at least one is wrong —
and the wrong one produces a server that registers and exposes nothing. The
`token match` check compares them by non-reversible fingerprint, so neither
value is ever read out, and it names only the two entries. When the entries
point at *different* hosts — say `suite.example.invalid` and
`suite.localhost.invalid`, two deployments on one box — two credentials is the
correct configuration, so the check reports `⋯ skipped` rather than inventing a
verdict.

One state is deliberately neither: `⏸ Pending approval` in `claude mcp list` is
a *project-approval* state, not a connectivity verdict. A pending server is
routinely delivering messages, so doctor reports it as `⋯ skipped — awaiting
project approval` and does not fail the run on that account.

## `suite deepseek`

A second kind of agent, and deliberately a different shape from `suite claude`.
`suite claude` wraps a binary you already installed and passes everything
through. `dsh` composes itself from a profile plus ordered patch files, so this
verb's real job is **materialising that composition on this machine** and then
getting out of the way.

```
suite deepseek --root ~/agents/oddjob
```

On each run it installs the harness if absent, copies the bundled federation
plugin into place, writes the composition patch, and execs `dsh`. Nothing is
cached that a re-run would not rebuild, so upgrading this CLI upgrades the
plugin with no separate publish step.

### One machine, several agents

`suite claude` federates the BOX, so the machine config names one runtime. An
agent root may instead carry its own identity, and when it does it wins
outright — a half-inherited identity is how an agent ends up connecting as its
neighbour:

| File | Holds |
| --- | --- |
| `<root>/suite.json` | Suite URL, runtime id, header **names**. No secret |
| `<root>/.suite-state.json` | The runtime token and header values. Mode `0600` |

Both have the same shape as the machine-level pair, so a working setup can be
copied and edited rather than re-derived.

### The generated patch is not a shipped file

`dsh` reads a plugin entry's `name:` as a **literal string** — that field is
consumed before `!!js` expressions are evaluated, so it cannot name a path that
is correct on two machines. The patch is therefore rendered per run with this
machine's resolved paths baked in. Everything that varies otherwise goes
through the environment, which *is* expanded.

Three things the patch does that are easy to get wrong, each pinned by a test:

- **Declares the provider route**, not merely the default model's name. Naming
  a provider without a matching `llm-pi-ai` route fails at the first turn with
  `NO_ADAPTER` — after the socket connects, with every status green.
- **Disables the one-shot runner.** The headless profile's runner tears the
  whole plugin tree down when its task ends, taking the agent factory with it;
  a plugin holding the event loop open then keeps the process alive around a
  dead tree.
- **Declares one MCP server per entry.** The client takes `serverName` as a
  field, not a `servers` map — and an invalid config there prints the fully
  resolved config, credentials included, to stderr.

### Credentials

One token. The runtime token authenticates both the federation websocket and
the MCP endpoint — verified against a live deployment rather than assumed. It
reaches the child through the environment and never through argv.

Deployments behind an access proxy may need extra headers. The CLI knows none
of them by name: whatever `headerNames` the config carries is forwarded from
the credential store as `SUITE_HEADER_<NORMALISED_NAME>`, and a deployment with
none works unchanged.

## `suite hermes`

Stamps a [Hermes Agent](https://github.com/NousResearch/hermes-agent) root
Suite-ready, then runs its gateway (`hermes gateway run`) in the tmux session
`suite-<root dir name>`. Hermes state lives under the root
(`HERMES_HOME=<root>/.hermes` unless `--hermes-home` says otherwise), never in
`~/.hermes`.

```
suite hermes --root ~/agents/scribe \
  --suite-url https://suite.example.invalid --runtime-id <id> \
  --token-ref file:/home/me/.config/suite/tokens/scribe \
  --model-base-url http://127.0.0.1:8080/v1 --model some-model
```

| Flag | Meaning |
| --- | --- |
| `--root DIR` | Required. The agent root; its directory name is the agent name |
| `--suite-url URL`, `--runtime-id ID` | The Suite runtime. Recorded in `<root>/suite.json`, so a re-run may omit them |
| `--token-ref REF`, `--keychain-service SVC` | The runtime token, by reference only (see [token refs](#token-refs)) |
| `--model-base-url URL`, `--model ID` | Required. An OpenAI-compatible endpoint and model id |
| `--context-length N` | Optional `model.context_length` |
| `--model-api-key-ref REF` | Optional model key, by reference |
| `--allowed-users LIST` | Passed to the channel installer; without it, `--allow-all-users` |
| `--hermes BIN`, `--install-hermes` | Which Hermes to use, or install the pinned one if absent |
| `--hermes-home DIR` | Override `HERMES_HOME` |
| `--full-toolset` | Leave the Suite platform's toolset to Hermes's own default instead of the lean one (see [the toolset](#the-suite-platforms-toolset-is-lean-by-default)) |
| `--stamp-only` | [The stamp contract](#stamp-contract---stamp-only): stamp, print one JSON document, start nothing |
| `--no-session` | Run the gateway in the foreground instead of in tmux |
| `-- ARGS` | Everything after `--` goes to `hermes gateway run` |

What it writes, and with what mode:

| Path | Written by | Mode | Holds |
| --- | --- | --- | --- |
| `<root>/suite.json` | this CLI | default (`0644` under a `022` umask) | Suite URL, runtime id, the token **ref**. No secret |
| `<root>/.suite-stamp.json` | this CLI | default | Stamp record: harness, writer and harness version, plugin ref, inputs digest, token ref, last verdict. A run that fails after its first write records `fail`, so an older `pass` never outlives it and `--gateway-only` refuses the root. A refusal before any write leaves it as it was. No secret |
| `$HERMES_HOME/mcp-tokens/startup-suite-platform.runtime-token` | the channel installer | `0600` | The runtime token: the one sanctioned copy |
| `$HERMES_HOME/.env` | the channel installer; this CLI adds `CUSTOM_MODEL_API_KEY` | `0600` for this CLI's write | Channel keys; the model key when `--model-api-key-ref` is given |
| `$HERMES_HOME/config.yaml` | `hermes config set` (model keys, the toolset key); the channel installer (`mcp_servers.startup-suite`) | Hermes's own | `model.provider`, `model.base_url`, `model.default`, optionally `model.context_length`, `model.key_env`; `platform_toolsets.startup_suite` unless `--full-toolset` |
| `$HERMES_HOME/plugins/startup-suite-platform` | the channel installer | the installer's | The channel plugin |
| `~/.local/share/suite/hermes-suite-channel` | this CLI (`git`) | git's | The channel checkout, pinned to one commit |
| `~/.local/state/suite/agents.json` | this CLI | default | The roster entry, on session creation |

With `--install-hermes` it also writes `~/.local/share/suite/hermes-agent/`
(`0700`, holding the pinned upstream installer, `0700`) and `$HERMES_HOME`
(`0700`). **The upstream installer writes outside `HERMES_HOME`**: shell rc PATH
lines and `~/.local/bin/{hermes,hermes-agent,hermes-acp}`. The stamp reports
that as its own action rather than hiding it.

**The MCP SDK.** The bridge needs `mcp==2.0.0` in Hermes's own Python. The
managed Hermes venv is made by `uv` and **has no pip** (measured: `No module
named pip`), so after `python -m pip` fails that way the install falls back to
`uv pip install --python <that python>`. With no `uv` on PATH, the failure
names the command to run.

**The token file.** hermes-suite-channel has no keychain resolver yet, so a
`keychain:` ref is resolved in memory, handed to the installer on stdin, and
materialised into the `0600` token file above. The stamp says so in `warnings`.

**The interpreter.** Every Hermes launcher at the pinned commit is a
`#!/bin/sh` wrapper, so the interpreter is not read from a shebang. It is asked
of Hermes (`hermes --run-module pm.environments` names the dependency venv it
selects), and passed to the channel installer as `--python`.

**The harness version** is the install's own commit: `git rev-parse HEAD` in
the `Install directory` that `hermes --version` prints, else the local
`g<sha>` of that line. Never its `upstream <sha>`, which is the remote tip Hermes
last fetched (measured: 49 commits ahead of the pinned install).

### The Suite platform's toolset is lean by default

The stamp sets **`platform_toolsets.startup_suite: [hermes-webhook]`**, and
only that key: no other platform's toolsets and not the global default.

- **What it leaves the agent.** `hermes-webhook` is `web_search`, `web_extract`,
  `vision_analyze` and `clarify`, plus every enabled MCP server: an explicit
  list that names no MCP server still merges all of them (hermes-agent
  `_merge_mcp_servers` at the pinned commit), so the Suite MCP bridge and its
  tools stay. No shell, file or code-execution tools.
- **Why this is the default.** A Suite channel agent reaches its capabilities
  through the Suite MCP bundle. Handing an agent that reads untrusted chat a
  shell and file tools by default widens what that chat can reach. And with
  Hermes's own default for the platform, the first prompt of a turn is
  **16,633 tokens** (measured at the pinned commit), which a model served with
  a 16K context cannot answer at all: `--context-length` declares the window,
  it does not shrink the prompt.
- **The opt-out.** `--full-toolset` leaves the key to Hermes. **It removes
  the key** when it holds exactly the lean list this stamp writes, so Hermes's
  own platform default applies again; it does not write a "full" list of its
  own. Serve the model with a context comfortably above the size above if you
  use it.
- **An operator's value wins.** If `platform_toolsets.startup_suite` holds
  anything other than the lean list, the stamp leaves it alone in either mode,
  reports the action `unchanged` and says so in `warnings`.
- **Idempotent.** A re-run in the same mode writes nothing. Switching between
  the default and `--full-toolset` is one `config set` or `config unset`,
  reported as `repaired` (or `written` on a first stamp) under the
  `config_set platform_toolsets.startup_suite` action.

This is a product default (2026-09-25), and can be reversed.

## `suite openclaw`

Stamps an [OpenClaw](https://www.npmjs.com/package/openclaw) root Suite-ready
through OpenClaw's own non-interactive path, then runs `openclaw gateway run` in
the tmux session `suite-<root dir name>`. State lives under the root
(`OPENCLAW_STATE_DIR=<root>/.openclaw`, `OPENCLAW_CONFIG_PATH=<root>/.openclaw/openclaw.json`,
`OPENCLAW_HOME=<root>`), never in `~/.openclaw`. The config is written by
upstream: `openclaw onboard --non-interactive --accept-risk` for the base, then
`openclaw config set` for every later key. openclaw.json is never hand-written.
The keys this verb manages are READ back from openclaw.json itself and compared
on the fields it owns: `openclaw config get --json` returns the account's
`token` as `__OPENCLAW_REDACTED__` and adds schema defaults, so it cannot say
whether the account is already right (measured at 2026.9.4).

**`plugins.allow` is exclusive**: once set, every plugin it does not name is
disabled, bundled ones included (measured: 39 bundled plugins load on a fresh
onboard, 1 with `plugins.allow` naming only this plugin, and `plugins doctor`
then fails on the harness's own `anthropic` entry). So a stamp that creates the
allowlist names every plugin `openclaw plugins list` reports enabled at that
moment, plus this one: what loads is unchanged except for this plugin. An
allowlist the operator already wrote is kept, with this plugin appended. A
plugin that a later OpenClaw release bundles is therefore not enabled until it
is added to the list.

| Flag | Meaning |
| --- | --- |
| `--root DIR` | Required. The agent root; its directory name is the agent id |
| `--suite-url URL`, `--runtime-id ID` | The Suite runtime |
| `--token-ref REF`, `--keychain-service SVC` | The runtime token, by reference only. The plugin resolves the ref itself: this CLI never reads the token |
| `--model-base-url URL`, `--model ID` | Required. The custom model provider |
| `--model-compat openai\|openai-responses\|anthropic` | Provider API shape. Default `openai` |
| `--model-api-key-ref REF` | Optional model key, by reference |
| `--gateway-port N` | The gateway port. Default: the first free port from `18800`; **never `18789`**, OpenClaw's default |
| `--openclaw BIN`, `--install-openclaw` | Which OpenClaw to use, or install the pinned one (`openclaw@2026.9.4`) |
| `--stamp-only` | [The stamp contract](#stamp-contract---stamp-only) |
| `--no-session` | Run the gateway in the foreground |
| `-- ARGS` | Passed to `openclaw gateway run`, except `--force`, `--port`, `--dev`, `--reset` and credential flags, which are refused |

What it writes, and with what mode:

| Path | Written by | Mode | Holds |
| --- | --- | --- | --- |
| `<root>/suite.json` | this CLI | default | Suite URL, runtime id, the token ref. No secret |
| `<root>/.suite-stamp.json` | this CLI | default | Stamp record, as for Hermes. No secret |
| `<root>/.openclaw/` | this CLI | `0700` | OpenClaw's state directory |
| `<root>/.openclaw/openclaw.json` | `openclaw onboard` / `openclaw config set` | OpenClaw's own | `gateway.port`, `plugins.load.paths`, `plugins.allow`, the plugin and channel entries, the account (its `token` is the **ref string**), one route binding |
| `~/.local/share/suite/openclaw-suite-channel` | this CLI (`git`, `npm ci`) | git's / npm's | The channel checkout pinned to one commit, and its dependencies |
| `~/.local/state/suite/agents.json` | this CLI | default | The roster entry, on session creation |

With `--install-openclaw` it also writes `~/.local/share/suite/openclaw/`
(`0700`), an npm prefix holding the pinned package; nothing global.

**The model key is not stored.** openclaw.json holds an env ref to
`CUSTOM_API_KEY`, and each launch resolves `--model-api-key-ref` into the
gateway's environment.

## Rules both stamp verbs keep

**No daemon.** Neither verb ever runs `gateway install`, `start` or `restart`,
`--install-daemon`, or `systemctl`. systemd `--user` is per UID, not per HOME,
so any of them could restart a gateway that some other install on the same
machine already runs. The gateway is always `gateway run`, in the foreground,
inside tmux.

**Per-root isolation.** Each agent's harness state lives under its root, and
every harness child runs with an allowlisted environment: it inherits no
`SUITE_*`, `HERMES_*` or `OPENCLAW_*` from the operator's shell. What two
agents on one machine do share lives under `~/.local/share/suite/`: the pinned
plugin checkouts and any managed harness install. Those are programs, not agent
state.

**The header limitation.** Neither channel plugin can forward extra HTTP
headers. A root whose `suite.json` names operator headers (for a deployment
behind an access proxy) is refused with exit `2` and `headers_unsupported`,
before anything is written.

`suite status` lists every stamped agent with its kind, root, session state and
last stamp verdict. A gateway that died takes its tmux session with it, so the
state comes from the roster, and a recorded agent that is not running is
reported `stale`, never absent.

## Stamp contract (`--stamp-only`)

`suite hermes --stamp-only` and `suite openclaw --stamp-only` are a stable,
machine-callable interface. **The intended caller is core's installer `setup
channel` step (task 01a0d6b9)**, which calls these verbs rather than
reimplementing them.

Under `--stamp-only`, stdout carries **exactly one JSON document** (indent 2,
trailing newline) and nothing else. Every human-readable line goes to stderr,
and no session is started.

### Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `contract_version` | number | `1` |
| `ok` | boolean | Stamped, and the post-write check passed |
| `harness` | string | `hermes` or `openclaw` |
| `agent` | object | `{name, root, runtime_id}` |
| `token_ref` | string or null | The token **ref** as given or recorded, never a value |
| `changed` | boolean | Whether any action that was applied wrote anything |
| `actions` | array | `{kind, target, outcome, applied}` per write; `outcome` is `written`, `unchanged` or `repaired`; `target` is a path, key or package, never a value. `applied` is measured: `true` once the write was performed (or when `unchanged` needed none), `false` for a planned write the run never reached. A failed run therefore lists the writes it did not make as `applied: false`, and a harness install that ran before a refusal is still listed |
| `validation` | object | `{verdict, checks}`; `verdict` is `pass`, `fail` or `unparseable`, and each check carries `command`, `exit_code`, `verdict` and, on a failure, the `raw` line |
| `harness_version` | string or null | The harness version the stamp ran against |
| `writer_version` | number | The version of this CLI's writer for that harness |
| `warnings` | array of strings | For example `config shape unverified for <harness> <version>` |
| `human_steps` | array | `{kind, text}` for a human to act on, such as `start_agent_session` or `keychain_unlock` |
| `error` | object or null | `{code, message}`. The message names paths, flags and item names, never a value |

**`contract_version: 1` changes additively only.** A new field may appear. An
existing field is never renamed, retyped or removed without bumping the version.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | ok: stamped, and the post-write check passed |
| `1` | failed: the harness or its check failed, or its output was unreadable |
| `2` | refused: a literal secret, a bad ref, operator headers, a busy port, a missing harness without its install flag |
| `3` | blocked on a human: a locked keychain or a missing keychain item. `human_steps` says what to do |

### Token refs

The runtime token is accepted **only by reference**:

```
--token-ref file:<absolute path>
--token-ref keychain:<item> --keychain-service <service>     (macOS only)
```

A literal value is refused with exit `2` in every spelling: `--token`,
`--token=...`, and a token piped on stdin. argv is readable through `ps`. A
`file:` ref is checked by stat and never read: the file must be a regular file
owned by the caller, mode `0600` or `0400`. A `keychain:` ref is resolved with
`/usr/bin/security find-generic-password -s <service> -a <item> -w`, so argv
carries names only. The same syntax is read by the OpenClaw channel plugin's own
resolver.

### Idempotence

A re-run with identical inputs changes nothing, reports every action
`unchanged`, and returns `changed: false`. `.suite-stamp.json` is rewritten only
when its bytes would change. The inputs digest covers the token **ref**, not the
value, so rotating the token behind the same ref leaves the digest alone. For
OpenClaw that is the whole story, because the plugin reads the ref itself. For
Hermes the channel installer copies the new value into its `0600` token file,
and that action reports `repaired`.

Hermes has one known dependency here. The channel installer decides whether
`config.yaml` already holds its MCP entry by parsing the YAML with the Hermes
Python, using `ruamel.yaml` or PyYAML. **If that Python has neither, the
installer cannot tell, and it rewrites its MCP keys on every run.** The managed
Hermes env ships `ruamel.yaml`, because Hermes needs it to read its own config.

### Follow-ups

1. **Upstream config-shape detection.** Each writer declares the harness
   versions its config shape was measured against. Any other version gets one
   warning and no drift detection. Detection belongs in `measuredHarnessVersions`
   and the `.suite-stamp.json` record, not inside a writer.
2. **A keychain resolver in hermes-suite-channel**, so the Hermes token needs
   no `0600` file.
3. **The OpenClaw secret-contract SecretRef**, as an alternative to the
   channel plugin's prefix resolver.
4. **openclaw-suite-channel's `install.sh` passes `--token` on argv.** This CLI
   does not call it, but other callers should not either until it is fixed.
5. **Operator headers**, which neither channel plugin can forward yet.
6. **The upstream Hermes `.env` child-env leak.** Hermes copies `.env` into its
   own environment every turn, and children it spawns without a scrub inherit
   it, model key included.
7. **The Hermes MCP command names a venv generation.** The interpreter the
   channel installer registers as `mcp_servers.startup-suite.command` is the
   dependency venv Hermes selected at stamp time, which Hermes may replace on
   `hermes update`. A re-run of the stamp repairs it; nothing does in between.

## Five decisions, stated rather than guessed

These are the questions the design had to answer, each answered here rather
than left to be inferred from behaviour:

1. [**How a session is named and scoped**](#session-naming--per-working-directory)
   — per working directory, derived not remembered.
2. [**What "already exists" means, and what happens to a stale
   session**](#what-already-exists-means) — three states, and a stale one is
   recycled out loud.
3. [**`$TMUX`: what happens when you run it from inside tmux**](#inside-tmux)
   — `switch-client`, never a nested session.
4. [**Whether `-p` bypasses tmux**](#-p-bypasses-tmux--a-decision-not-an-accident)
   — it does, entirely.
5. [**What happens when tmux is absent**](#when-tmux-is-absent) — a direct run
   with a loud warning. **Never a silent fallback.**

## Versioning

`package.json` holds the version, and it is the only place it lives —
`suite --version`, the POSIX launcher and `install.sh`'s banner all read it.

**Bump it in the same PR as the change**, and add the `CHANGELOG.md` entry in
that same PR. Someone running an installed CLI answers "is there anything new
since mine?" by comparing `suite --version` against the changelog; a change that
ships without a bump is invisible to them, and a bump without an entry tells
them something moved but not what.

Minor for a new capability or a changed default, patch for a fix that changes no
behaviour anyone relied on. A test asserts the changelog's newest heading equals
the shipped version, so the two cannot drift apart silently.

## Credentials and config

Credentials are **pasted in**: you click Federate in the Suite UI and paste the
values at the prompt. There is deliberately no device-code or `suite login`
flow yet — it is deferred, and when it lands it becomes another provider behind
the same credential store, changing nothing else.

Nothing you paste is echoed. The token confirmation is a character count
(`set, 44 chars`) and never a prefix or a last-four tail: a tail is still a
partial echo, and a count already answers the only question you have.

`~/.config/suite/config.json` (or `$XDG_CONFIG_HOME/suite/config.json`) is the
repeatable-install file. It holds the Suite URL, the runtime id, the **names**
of any extra headers, and the session-naming preference. **It never holds a
secret value** — a test asserts the serialised bytes contain neither the token
nor any header value.

Writes default to **user scope**. If a write would land inside a git
repository, `suite` asks `git check-ignore` and **refuses** — non-zero exit, a
message naming the path — unless the path is ignored. Refusal rather than a
warning, because a warned-then-written credential file is a committed one.

## Persistent sessions

Agents run inside `tmux`, so closing the terminal does not kill the agent. An
agent that dies with its terminal stops mid-task, and from Suite's side that is
indistinguishable from an agent that is merely slow.

**The backend is tmux specifically.** There is no multiplexer abstraction and
no `screen`/`zellij` backend: a second implementation is what would earn an
interface, and one implementation behind one is just indirection.

### Session naming — per working directory

The session name is `suite-<directory name>-<8 hex of sha256 of the absolute
path>`, e.g. `suite-ledger-3f2a91c0`. Two requirements decide this:

* **`suite claude` twice from the same place must find the same session.** The
  name is a pure function of the resolved absolute path, so nothing has to be
  remembered, looked up, or kept in sync with a state file that can drift.
* **Two projects must not collide.** The digest is of the absolute path, so
  `~/a/ledger` and `~/b/ledger` share the readable half and differ in the half
  that identifies them.

The two alternatives were rejected on that second requirement.
**Per runtime id** gives one box one session, so the second project silently
attaches to the first project's agent — a collision that presents as a
successful re-attach. It is still available as `sessionNaming: "runtime"` in
the config, because it is the right rule for a box that genuinely runs one
agent. **An explicit name only** would be correct but requires the user to
remember it, and a forgotten name means a second agent rather than an error.
`--session NAME` therefore exists as a per-invocation override for the user who
wants two agents in one directory, and is not persisted.

Names are sanitised to `[A-Za-z0-9_-]`. tmux addresses panes as
`session:window.pane`, so a `.` or `:` in a session name makes `-t <name>`
ambiguous. Sanitising cannot merge two projects, because the discriminating
half of the name is a hash of the *unsanitised* path.

### What "already exists" means

<a id="what-already-exists-means"></a>

"A session already exists" is **not** the question `tmux has-session` answers.
It answers "is there a session with this name", which stays true long after the
agent inside it has died. `suite` treats a session as existing-and-usable only
when an **agent process is running inside it** — anything else is a name, not an
agent.

So `suite claude` resolves to exactly one of three outcomes:

| Detected | What `suite claude` does |
| --- | --- |
| **live** | Attaches. Same agent, same history, nothing restarted |
| **stale** | **Names it on stdout, kills that one session by name, starts a fresh agent.** Never a silent attach |
| **none** | Creates the session detached, then attaches |

**A stale session is recycled, not adopted and not ignored.** Adopting it
presents a dead agent as a healthy one: you get a shell prompt, Suite gets
nothing, and nothing anywhere says why. Ignoring it and picking a different
name breaks the one property the naming rule exists to provide — one context,
one session. The kill is `tmux kill-session -t <name>`, scoped to that single
name; `kill-server` is never used anywhere in this tool, because it would take
down every other agent on the box.

### Scrolling: sessions are created with mouse mode on

A session `suite` creates gets `mouse on`, **scoped to that session** — never
`-g`, because a global set would reach tmux sessions this CLI never created.

Without it, tmux translates a wheel event inside a full-screen application into
**arrow keys**, so scrolling an agent walks its input history instead of its
scrollback and the agent reports something like *"scroll wheel is sending arrow
keys — use PgUp/PgDn to scroll"*. With mouse mode on, the wheel reaches the
pane's scrollback.

The trade, stated because it is the reason not to do this blindly: mouse mode
also routes click-drag to tmux's selection rather than the terminal's, so a
native selection needs the terminal's override modifier held down — **Option**
on macOS, **Shift** elsewhere.

Only *new* sessions are configured. Reattaching never re-configures a session
you are already working in. To change one that already exists, or to undo it:

```sh
tmux set-option -t <session> mouse on    # or: off
```

### Three states, not two

`suite` reports **live**, **stale**, or **none** for a session:

| State | Meaning |
| --- | --- |
| `live` | The session exists and an agent process is running inside it |
| `stale` | The session exists and its shell is alive, but the agent is gone |
| `none` | No session by that name |

**`tmux has-session` cannot tell live from stale**, and that is the whole
problem. A tmux session routinely outlives the process it was created for: the
agent exits, the pane's shell remains, and `has-session` answers yes forever.
Attaching to that corpse is worse than starting fresh, because it looks like a
live agent — you see a prompt, Suite sees nothing, and nothing says why.

So detection lists panes (`tmux list-panes -a -F` with `#{pane_pid}` and
`#{pane_current_command}`) and **walks the pane's process descendants**. The
agent is normally a *child* of the pane's shell, so checking the pane command
alone would call every live session stale. Both the executable name and the
words of the command line are matched, because Claude Code appears as
`comm=claude` when installed as a binary and as `node …/claude` when installed
as a JS entrypoint.

### Quoting

Arguments are handed to `tmux new-session -d -s <name> <cmd> <arg>…` as
**separate argv elements**, never folded into one shell string — folding means
re-quoting for a shell that then re-splits, which is exactly how an argument
containing a space or a quote gets corrupted. The composition is a pure
function, tested against arguments containing spaces, single and double quotes,
`$VAR`, a leading `-`, backslashes and embedded newlines, and separately round
tripped through a real tmux to prove the process in the pane receives them byte
for byte. One audited single-quote escaper exists for the display-only case.

### No secret is ever a tmux argument

A command line is world-readable through `ps`, and a `tmux new-session` command
line stays in the process table for the life of the agent. Credentials reach
Claude through the MCP config written at `suite init` time. The composed argv is
checked against the credential store before it is run, and `send-keys` is never
used — typing a secret into a live shell would add its history to the exposure.

### Inside tmux — `$TMUX` is set

<a id="inside-tmux"></a>

Running `suite claude` from inside a tmux pane must not put tmux inside tmux.
`suite` reads `$TMUX`, and when it is set it **switches the current client** to
the target session (`tmux switch-client -t <name>`) instead of attaching. A
nested attach produces a session you cannot detach from without thinking about
which prefix key you are talking to, and it is the shape people accidentally
create when a wrapper ignores the variable.

Where switching is not possible, `suite` **refuses with a non-zero exit and
names the command to run instead**. It never quietly produces a nested session:
the two failure modes here are "nothing happens" and "something confusing
happens", and a refusal that says what to do is neither.

### When tmux is absent

<a id="when-tmux-is-absent"></a>

`suite` runs the agent **directly**, and prints a warning on stderr saying, in
words, that the session will die with this terminal and naming the install
command for this platform.

**The fallback is never silent.** A silent one would reproduce exactly the
failure this feature exists to prevent — an agent that vanishes with its
terminal, which from Suite's side is indistinguishable from an agent that is
merely slow. `suite init` also offers to install tmux, and `suite doctor` fails
the tmux check with a runnable remedy, so a box in this state announces itself
three separate times.

## `suite update`

`suite update` replaces this install with the latest published CLI. It does that
by **re-running `install.sh`** — the same script the cold-start
`curl … | sh` runs — rather than fetching and unpacking a tarball itself. One
install path, not two: a second mechanism is a second thing to keep true, and
the half that drifts is always the one nobody runs on a fresh machine. Staging
before the move, never leaving a partial file at the destination, no sudo, and
naming the version it is about to replace are all inherited rather than
reimplemented.

It prints the installer URL **before** it fetches anything — the same
`NOTHING SILENT` rule the `claude` wrapper carries. A command that pipes a
remote script into a shell should say so first.

The installer's own `replace 0.1.0 with 0.2.0? [y/N]` prompt is **not**
auto-answered. That prompt exists to stop a silent overwrite, and an update that
answers it for you defeats it; the installer inherits your terminal and you
answer it directly.

`SUITE_CLI_REF` selects a branch, tag or commit instead of `main`. Both halves —
the URL the installer is fetched from *and* the ref exported into its
environment — come from that one value. This matters more than it looks:
`install.sh` **defaults `SUITE_CLI_REF` to `main` and infers nothing from the
URL it was downloaded from**, so fetching a tag's installer without exporting
the ref installs `main` and prints a perfectly successful-looking install of the
wrong thing. A ref containing anything other than letters, digits, `.`, `_`,
`-`, `/` is refused by name rather than quoted and hoped for.

Update needs `curl` or `wget`, plus `tar` and `sh`. A missing one is named up
front, before the announcement, rather than surfacing as broken-pipe noise three
commands later.

## `suite claude`

`suite claude [...]` runs
`claude --dangerously-load-development-channels server:suite-channel
--dangerously-skip-permissions --continue <your args>`
inside the session for this directory. Channel plugins must be on Anthropic's
allowlist to load normally; until this one is approved every session needs that
flag, and the wrapper injects it so that when it is approved the flag
disappears from one place and nobody's muscle memory changes.

The other two are what make an agent a **participant** rather than a prompt:

* `--dangerously-skip-permissions` — a Suite runtime is unattended. Without it
  the agent stops on the first tool-call prompt and waits for somebody who is
  not there, and the task reads as hung when it is only asking a question.
* `--continue` — without it every launch is a cold session, so re-attaching to
  a runtime throws away everything it knew. In a directory with no prior
  conversation it simply starts a fresh one, so it is always safe to pass.

`--continue` stands down if you choose a session yourself — `--resume`, `-r`,
`-c`, `--from-pr` or `--teleport` — because handing Claude two session
instructions is how you get the wrong one. Neither flag is added twice if you
pass it. Passthrough is otherwise unchanged and still total.

* **live** → attach. **none** → create detached, then attach. `Ctrl-b d`, or
  closing the terminal, leaves the agent running; `suite claude` again
  re-attaches to the *same* session.
* **stale** → **recycled, out loud.** The dead session is named on stdout, then
  killed by name (`kill-session -t`, never `kill-server`) and a fresh agent
  starts. Silently attaching would present a dead agent as a healthy one.
* `suite claude new [...]` is the **one** explicit way to force a second
  session; it picks the next free name (`…-2`, `…-3`) rather than colliding.
* The child's exit code is `suite`'s exit code, and the attach path keeps the
  real TTY.

### `-p` bypasses tmux — a decision, not an accident

`suite claude -p '…'` **execs Claude directly and never touches tmux**, not even
to detect session state. `-p` is a one-shot scripted call whose output the
caller captures: forcing it through an interactive attach would hide its stdout
inside a pane, hand it a terminal it does not want, and leave a session behind
for a process that had nothing to persist. There is no session to keep alive,
so there is nothing for tmux to buy. `--print` is treated identically, including
after `--`, because that is how Claude itself reads it.

### Passthrough is total

The wrapper parses the verb `new` and a single leading `--`, and nothing else.
Every other argument reaches Claude **verbatim and in order**, after the
injected flag — `--resume`, `--version`, `-p`, and arguments that look like
flags a wrapper might want to own. Nothing goes near a shell, so `$HOME`,
quotes and spaces are literal bytes. Tests assert the exact delivered argv for
each of those cases. `suite claude -- new` is how you send the literal word
`new` to Claude.

### Two agents on one machine

Two runtimes on the same box, each wanting its own persistent session, is what
`--session` is for:

```
suite claude --session brosnan
suite claude --session moore
```

Each name resolves to its own tmux session, from the same directory, and each
re-attaches to its own agent on the next run. It is the **one** option the
wrapper parses; everything else still passes through verbatim, and after a `--`
even `--session` belongs to Claude again.

`sessionNaming: "runtime"` in `config.json` looks like the answer and usually is
not. It names the session after the runtime id — but the runtime id comes from
`config.json`, and agents sharing a `HOME` share that file. Two agents under one
account would therefore resolve to the **same** session and silently attach to
each other: a collision that looks exactly like a successful re-attach. It is
the right rule only when a box runs one agent, or when each agent has its own
`XDG_CONFIG_HOME`.

### The first-run notice

On the **first run on a machine only**, `suite claude` prints one line saying it
is loading a development channel plugin that is not yet on Anthropic's
allowlist and is skipping permission checks — a `!` in yellow, the sentence at default weight, a blank line, and
silence on every run after that. No box and no border: a box is recurring chrome
that reads as a permanent banner, and this is something that happened once, not
something that lives there. It is deliberate rather than noise — **a wrapper
that silently hides a flag containing the word "dangerously" trains you not to
look at the next one.** The seen-flag is stored in
`~/.config/suite/state.json`, never in a repository.

## MCP registration

`suite init` writes both MCP entries with `claude mcp add` rather than editing
`.mcp.json` by hand — the file format is Claude Code's to change. They are
registered at **local scope** (`-s local`, passed explicitly), run from the
agent directory: private to that directory, stored in `~/.claude.json` under
its key (or under the enclosing git work tree's root, if it is inside one), and
never written into the directory itself.

**Not user scope.** User scope is one entry for every Claude on the machine, so
before 0.5.0 installing a second agent silently re-pointed the first at the
second one's Suite and runtime. **Not project scope** (`.mcp.json`) either:
that puts the token inside the agent directory, where a repository can commit
it, and each server then needs approving. A user-scope entry left by an older
`suite init` is **left alone** — another agent directory may still be running
on it — and `init` warns when it names a different runtime; this directory's
local entry takes precedence here regardless.

Being written is not being connected, so `init` finishes by health-checking
with `claude mcp list` and requires both `suite-channel` and `startup-suite` to
report connected. A status line it cannot parse is a **failure that prints the
raw line**, never a green result on an assumption.

### `${ENV_VAR}` interpolation — measured, not guessed

Tested against Claude Code 2.1.228 with a stub stdio server that recorded its
own environment:

* `claude mcp add x -e K='${V}'` stores the **literal** `${V}` in the config.
* If `V` **is** set when `claude` launches, the server receives the **expanded**
  value. Interpolation is real, and it happens at spawn time.
* If `V` is **not** set, the server receives the literal string `${V}` — not an
  empty value, and not an error.

That last case decides the default. An env reference that quietly hands
`${SUITE_TOKEN}` to the channel as a bearer token produces a session that
authenticates with garbage and names no cause. So the **default is an inline
value at local scope** (in the mode-600 `~/.claude.json`), and the reference form is opt-in for operators keeping
secrets in a manager: `suite init --token-from-env SUITE_TOKEN`, which then
requires that variable to be exported wherever `claude` is launched.

## Language

TypeScript on [bun](https://bun.sh). `bun` is already a hard dependency of the
Suite channel plugin, so it adds no new requirement, and the prompt loops, JSON
parsing and `tmux` argument composition are meaningfully safer there than in
shell.

`install.sh` is the exception and is deliberately **POSIX `sh`**: it runs via
`curl … | sh` before anything is installed on the machine, including `bun`.

## Development

```sh
bun install
bun test          # bun:test
bun run lint      # shellcheck install.sh bin/suite.template
bun run typecheck # tsc --noEmit
```

CI runs the same three on **macOS and Linux**, and **installs a real `tmux` on
both** rather than stubbing it. A stubbed tmux cannot prove that a process
outlived its parent, so a runner without one would skip the only tests that
matter and still go green. Absence of tmux is therefore a test **failure**, not
a skip.

### The two harnesses

**`test/clean-env/fixture.ts` — a scratch machine.** Each test gets its own
`HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and a `PATH` containing nothing but
the stubs it asked for. On any real box `bun`, `tmux`, the plugin and both MCP
entries already exist, so `init` and `doctor` would pass there without
executing a single install path or rendering a single failure. The `init` and
`doctor` suites share this one fixture: two hand-rolled copies of "a machine
without bun" drift, and the copy that drifts is the one that stops testing
anything.

**`test/persistence/parent-severing.test.ts` — the persistence proof.** The
claim is not that a session exists; it is that **the agent survives the
terminal that started it**. So the test starts an agent through the shipped CLI
**from a child shell**, records the pid of the process inside the pane,
**kills that parent shell** (SIGHUP, as a closing terminal delivers, then
SIGKILL as a backstop), and then from a **new shell** asserts the *same pid* is
still running and that `suite claude` re-attaches to the same session. It also
asserts the parent really died, and finishes by killing the agent to prove the
liveness probe can report death at all.

`Ctrl-b d` is deliberately *not* what is tested: a detach is a cooperative
gesture from a process that is still running, which is the opposite of the
event being claimed. Starting and re-attaching within one shell proves nothing
either.

Hygiene, because this runs on shared machines: a private `$TMUX_TMPDIR` so no
session belonging to anyone else is even visible; only sessions the harness
created are killed, by name, one at a time; **never `kill-server` and never a
pattern kill**; and every signal goes to a numeric pid the harness itself
spawned, re-checked with `ps -p` immediately before the signal.

### What the tests do not prove

Read this before citing a green suite as evidence of a cold start:

* A scratch `HOME` **cannot prove a real `bun` install** on a machine that never
  had bun. The `bun` on the fixture's `PATH` is a shell script that prints a
  version.
* A scratch `HOME` **cannot prove a real network clone** of the channel plugin,
  or a real dependency resolution. The `git` stub creates the directory a clone
  would have left behind.
* A scratch `HOME` **cannot prove `unzip`- or `claude`-absence** either. Both
  are decided by a `PATH` lookup, and the fixture's `PATH` is curated: it proves
  the guard fires for a tool the fixture withheld, not that the tool is absent
  from the machine. **Only a container (or a genuinely fresh box) can prove
  that** — which is how the missing-`unzip` bug was found in the first place.

What those tests do prove is that the code **takes** the clone and install
paths, in order, with the right arguments, cwd and scope, on a machine where
the tool is genuinely absent. A real cold start needs a container or a
genuinely fresh machine and is out of scope for a unit suite. The tests that
depend on a stub for something real are marked in-source with
`STUBBED_NOT_PROVEN` — grep for it.

The persistence test has its own honest limit: the agent is a long-lived stub
named `claude`, not Claude Code, so it needs no credentials and runs in
seconds. What is under test there is the **process topology** — whether the
pane process outlives the shell that launched it — which does not depend on
what the pane process is.

### Typography

Where this README is rendered on a hosted page, code is set in **JetBrains
Mono**, the same face the CLI's own output is designed against, so the page you
read and the terminal you paste into look like one product rather than two.

Every example value in this repository is invented —
`https://suite.example.invalid`,
`runtime_00000000-0000-0000-0000-000000000000`. Header names are
operator-specific: none are hardcoded, and whatever fronts your deployment is
asked for at `suite init` time.

## Licence

MIT. See [LICENSE](LICENSE).
