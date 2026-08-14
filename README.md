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
