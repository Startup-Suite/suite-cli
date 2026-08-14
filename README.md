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

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Startup-Suite/suite-cli/main/install.sh | sh
```

The installer never uses `sudo`. It installs to `$XDG_BIN_HOME`, or
`~/.local/bin` when that is unset, tells you if that directory is not on your
`PATH`, and prints the exact `export PATH=` line to add. If a `suite` is
already installed it names the version it would replace and asks first.

Then:

```sh
suite init
```

## Commands

| Command | What it does |
| --- | --- |
| `suite init` | Detects `bun` and `tmux`, installs the channel plugin, collects credentials, registers the MCP entries |
| `suite claude [...]` | Runs Claude Code in a persistent session; re-attaches to an existing one |
| `suite claude new [...]` | Forces a new session even when one exists |
| `suite doctor` | Diagnoses a broken setup, one runnable remedy per failure |
| `suite status` | Shows which runtime this box is federated as, and the state of each session |

Stage 1 ships the installer and the verb dispatch; the verbs themselves are
stubs until the later stages land. This README is a placeholder and is
rewritten in full, with every design decision justified, in stage 7.

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

### Inside tmux, and without tmux

Run from inside tmux, `suite` uses `switch-client` rather than attaching; it
never nests a session inside itself, and where switching is not possible it
refuses with the command to run instead.

If tmux is not installed, `suite` can still run the agent directly — **with a
warning**, never silently. A silent fallback would reproduce the exact failure
persistence exists to prevent.

## MCP registration

`suite init` writes both MCP entries with `claude mcp add` rather than editing
`.mcp.json` by hand — the file format is Claude Code's to change, and only
`claude mcp add` decides scope. **The scope default is `local`**, so `-s user`
is passed explicitly on every invocation; omitting it silently scopes the entry
to one directory.

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
value at user scope**, and the reference form is opt-in for operators keeping
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

CI runs the same three on macOS and Linux.

Every example value in this repository is invented —
`https://suite.example.invalid`,
`runtime_00000000-0000-0000-0000-000000000000`. Header names are
operator-specific: none are hardcoded, and whatever fronts your deployment is
asked for at `suite init` time.

## Licence

MIT. See [LICENSE](LICENSE).
