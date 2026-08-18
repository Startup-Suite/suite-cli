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
| `suite update` | Re-runs the installer to replace this install with the latest published CLI |
| `suite doctor` | Diagnoses a broken setup — one runnable remedy per failure, and a stale session is never reported green |
| `suite status` | Shows which runtime this box is federated as, and the state and age of each session |
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
