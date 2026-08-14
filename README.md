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
