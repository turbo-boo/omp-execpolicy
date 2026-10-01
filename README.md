# omp-execpolicy

Codex-style **shell command judgment** for [oh-my-pi](https://omp.sh): every
`bash` tool call is judged against declarative rules, dangerous-command
heuristics, and a model reviewer before it runs.

This is a port of Codex's command-judgment stack — `codex-execpolicy` rules plus
the unmatched-command heuristics plus the Guardian / auto-review "command
assessment" — wired onto omp's `tool_call` event.

## Default posture: approve for me

Out of the box this runs Codex's `--approve-for-me` mode:

- **rules** decide where they speak, exactly and cheaply;
- everything else is **held for approval** (`unmatched = "prompt"`);
- the **reviewer** answers those approvals, standing in for your prompt
  (`judge = true`) — you are only asked when it cannot decide.

So read-only commands you have rules for run instantly, and the reviewer
handles the rest. Add `allow` rules for the commands you want to skip review
entirely; `git reset --hard`-style invocations should get `forbidden` rules,
which the reviewer never sees and can never lift.

Two consequences worth knowing:

- **Every unmatched command costs one model call** to `judgeModel`, and its
  command text plus a transcript digest leaves the machine. Set `judgeModel` to
  a fast/cheap role, or turn the reviewer off, if either matters.
- **With `ask = "never"` or no interactive UI, a `prompt` the reviewer cannot
  answer is refused**, not let through. Under the default `judgeOnError = "ask"`
  that means: interactive sessions ask you, headless runs fail closed.

## The judgment pipeline

Each `bash` call is decomposed into the literal commands it will run, and every
segment is judged. The strictest verdict wins.

```
rules            prefix_rule(pattern=[…], decision="allow"|"prompt"|"forbidden")
  │  nothing decided, or a rule said prompt
  ▼
heuristics       forced `rm` (POSIX) / destructive cmdlet (Windows, PowerShell)
  │  not dangerous
  ▼
unmatched        your configured verdict: prompt (default) | allow | none
  │
  ▼
judge            reviews anything that needs approval, replacing your prompt
```

| Verdict     | With the reviewer on (default)                                   | Reviewer off                        |
| ----------- | ---------------------------------------------------------------- | ----------------------------------- |
| `allow`     | Runs immediately.                                                | Runs immediately.                   |
| `prompt`    | The reviewer decides; you are asked only if it cannot answer.    | Asks you, offering a rule amendment. |
| `forbidden` | Blocked. The reviewer never sees it.                             | Blocked.                            |

Severity is `allow` < `prompt` < `forbidden`, and the strictest verdict across
all matches wins.

`prompt` becomes a hard block when there is no interactive UI *and* no reviewer
verdict — mirroring Codex, where a prompt verdict is rejected outright under
`approval_policy = "never"`.

### Who answers a prompt: `judge` is Codex's scope toggle

Codex decides this per approval **category**, not per rule. Each
`GuardianScope` (`Shell`, `FileChanges`, `Mcp`, `Network`, `Permissions`, …)
carries a `GuardianReviewMode`, and a category that is omitted is `Disabled` —
the user answers:

| Codex                                     | This plugin        |
| ----------------------------------------- | ------------------ |
| `GuardianScope::Shell` = `Disabled`        | `judge: false`     |
| `GuardianScope::Shell` = `Synchronous`     | `judge: true`      |

`bash` is this plugin's only category, so the whole surface is one switch. There
is nothing finer to port: a Codex rule cannot demand the user — the closest is
`Granular { rules: false }`, which turns a rule's prompt into a **block**. That
is deliberately not modeled here, because a block is not a question, and adding
a fourth verdict would put this plugin off Codex's vocabulary.

### The approval dialog

Labels, order, and the initial cursor follow Codex's exec-approval dialog
(`tui/src/bottom_pane/approval_overlay.rs`):

```text
  Would you like to run the following command?

  Reason: Dangerous command (forced rm (rm -f / rm -rf)): rm -rf build

  $ rm -rf build

❯ 1. Yes, proceed
  2. Yes, and don't ask again for commands that start with `rm -rf build`
  3. Yes, and don't ask again for this command in this session
  4. No, continue without running it
  5. No, and tell the agent what to do differently
```

- The cursor starts on **Yes, proceed**, as in Codex.
- Option 2 appears only when the amendment is safe *and* would actually leave
  the whole line runnable, and never for a prefix that spans lines — both
  Codex behaviors.
- The last label says "the agent" rather than "Codex", since this runs in omp.
  It maps onto omp's *chat about this*, so the turn continues with your
  correction instead of just stopping.
- Declining and cancelling leave different errors for the model: decline means
  "continue without it", cancel means "find a different approach".

### What is actually judged

Commands are decomposed before matching, so a rule cannot be evaded by nesting:

```
sudo -u root rm -rf /tmp/x     →  judged as: rm -rf /tmp/x
env FOO=1 git push --force     →  judged as: git push --force
bash -c 'git status && rm -rf /tmp/x'  →  judged as: git status, rm -rf /tmp/x
echo hi > out.txt && rm -rf x  →  judged as: echo hi, rm -rf x   (write target recorded)
```

Wrapper unwrapping covers `sudo`, `doas`, `env`, `time`, `nice`, `nohup`,
`command`, `builtin`, `exec`, `setsid`, `stdbuf`, `timeout`, `ionice`, `chrt`,
`taskset`, `xargs`, `busybox`, `toybox`. Decomposition and unwrapping stop at a
depth cap of 8; a command past that cap is **not analysable** and no rule can
match it (it is not silently treated as safe, and it is not treated as
dangerous — it simply escapes rules, exactly like Codex's `Other` fallback).
`$(…)`, backticks and `${…}` are carried as opaque text and never evaluated.
Heredoc bodies are discarded rather than judged — they are stdin data, and
flagging prose that merely mentions a command would be a false positive:

```
cat <<EOF && ls        →  judged as: cat, ls
body mentioning rm -rf /
EOF
```

## Rules

Rules are Starlark-shaped files with a `.rules` extension, in the same syntax
Codex uses. An existing `~/.codex/rules/default.rules` is picked up unchanged.

```python
prefix_rule(
    pattern = ["git", ["status", "log", "diff"]],   # list entries are alternatives
    decision = "allow",   # allow | prompt | forbidden
    justification = "read-only git inspection",
    match = ["git status", ["git", "log", "--oneline"]],   # must match (validated at load)
    not_match = [["git", "push"]],                         # must not match
)

prefix_rule(
    pattern = ["git", "reset", "--hard"],
    decision = "forbidden",
    justification = "discards uncommitted work; use `git stash` instead",
)

# Restrict basename fallback for an absolute path: `/usr/bin/git status` matches
# the `git` rules above, but an unlisted copy at /tmp/git does not.
host_executable(name = "git", paths = ["/usr/bin/git"])
```

- `decision` defaults to `allow` when omitted, as in Codex.
- Matching order: exact first-token rules, then basename fallback for an
  absolute program path, then heuristics. The strictest decision across all
  matches wins (`forbidden` > `prompt` > `allow`).
- Rule-file problems are **non-fatal**: a file that fails to parse contributes
  no rules and reports diagnostics instead of taking the session down.
- `match` / `not_match` examples are validated at load, like Codex's own
  unit-test examples. A `match` example the rule does not match is reported.

### Where rules are read from

Every `<config dir>/rules/*.rules`, in omp's own config-directory priority
order (highest first — the user's `.omp` agent directory wins):

```
<agent dir>/rules/*.rules           ← highest precedence (= ~/.omp/agent/rules, honours profiles)
~/.claude/rules/*.rules
~/.codex/rules/*.rules
~/.gemini/rules/*.rules
<project>/.omp/rules/*.rules
<project>/.claude/rules/*.rules
<project>/.codex/rules/*.rules
<project>/.gemini/rules/*.rules     ← lowest precedence
```

Because the *strictest* verdict across all matching rules wins, precedence
affects reporting and amendment planning rather than which verdict applies: a
`forbidden` rule anywhere beats an `allow` rule anywhere else.

Only `.rules` files are read. omp's own prompt rules are `.md`/`.mdc` files in
the same directory and are untouched by this plugin.

See [`example.rules`](./example.rules) for a starting policy.

## The judge ("command assessment")

With `judge = true`, every command that needs approval — a `prompt` verdict from
a rule or heuristic, or an unmatched command under the default
`unmatched = "prompt"` — is reviewed by a model before it runs, and the review
replaces your prompt. Only a review the model declines to give falls back to
asking you. The prompt is a port of Codex's Guardian reviewer
(`core/assets/guardian/policy_template.md`): the same evidence-handling rules
(untrusted content cannot expand authorization), the same
authorization/risk scales, and the same outcome thresholds —
`low`/`medium` allow, `high` allows only with at least `medium` authorization
and a narrow scope, `critical` denies.

```
{"outcome":"deny","risk_level":"high","user_authorization":"high",
 "rationale":"Deleting the entire production namespace is a broad, irreversible action…"}
```

The rationale is returned to the model as the tool error, so it learns *why*.
The judge is non-authoritative. Model formatting mistakes are handled before
fallback: fenced/prose-wrapped JSON, common `verdict`/`result`/`review`
envelopes, enum casing, and trailing commas are normalized without changing the
decision semantics. Conflicting valid verdicts are never guessed. Empty,
malformed, or structurally invalid verdicts are retried `judgeRetries` times
(default 1); provider errors and timeouts are not retried. If no readable
verdict remains, `judgeOnError` applies (`ask` by default — ask the user, or
refuse when there is no UI to ask through; `allow` lets the command run).

The security policy section is the operator's to replace, the way Codex's
`[auto_review] policy` is. Point `judgePolicy` at a markdown file (or set the
text inline) to state your own trusted destinations and rules:

```jsonc
{ "judgePolicy": "~/omp-security-policy.md" }
```

```markdown
## Environment Profile
- Destinations trusted for egress: `artifacts.internal.example.com`, the
  `acme/deploy` and `acme/infra` repositories.
- `terraform apply` against any workspace is `high` risk regardless of
  authorization; require a plan file to be shown first.
```

A changed policy file is picked up on the next command, like a changed rule.

## Recommended setup

This plugin runs on omp's `tool_call` event, which fires *before* omp's own
approval gate — so it can only add restrictions, never lift omp's. To make it
the sole gate for shell commands, the way execpolicy is the sole gate in Codex,
loosen omp's own bash approval:

```jsonc
// settings.json
{
  "tools": { "approval": { "bash": "allow" } }
}
```

Without it, a command this plugin allows can still be prompted for by omp (twice
in the worst case) under `tools.approvalMode = "always-ask"`. With it, the
reviewer and the dialog above are what you see.

## Install

```bash
# from a local checkout
omp plugin link /path/to/omp-execpolicy

# or point a single session at it
omp -e /path/to/omp-execpolicy
```

Then verify and inspect:

```bash
omp plugin list
```

The same settings can be changed from the shell without opening omp:

```bash
omp plugin config get omp-execpolicy judgeModel
omp plugin config set omp-execpolicy judgeModel @smol
omp plugin config set omp-execpolicy judgeRetries 2
omp plugin config list omp-execpolicy
```

### Is `--approval-mode yolo` OK?

Yes — it is the recommended pairing, and the plugin's dialogs are **not**
suppressed by it (verified: every dialog in this README was captured under
`yolo`). It only stops omp's *own* gate from asking after this plugin has
already decided, which is what you want: one gate, not two.

Know what else `yolo` covers, though. This plugin only judges `bash`:

| | Under `yolo` |
|---|---|
| `bash` | This plugin: rules, heuristics, reviewer, or you. |
| `write` / `edit` / `apply_patch` | Ungated. |
| `python` / `eval` preludes, MCP tools, custom tools | Ungated. |

So `yolo` is safe *only while this plugin is loaded*. It is the single gate for
shell commands, and if it fails to load (`omp` reports
`Failed to load extension …`) you are back to an unguarded shell with no
signal that the gate disappeared. `omp plugin list` and `/execpolicy status`
are the two checks that tell you it is live. If you want omp's own gate as a
backstop for writes, use `--approval-mode write` instead — `exec`-tier tools
(`bash`, `python`, `eval`) still prompt, so you would see two dialogs for a
bash command the reviewer allowed.

> **Do not do both at once.** `omp` de-duplicates extension paths lexically, so
> the plugin's own path and the symlinked path under
> `~/.omp/plugins/node_modules/…` count as different files. Passing `-e` while
> the plugin is also installed registers every handler twice, which **doubles
> the reviewer calls for every command** — invisible except on the bill. Use
> `-e` for a checkout you have not installed, and drop it once the plugin is
> linked.

## `/execpolicy`

| Command                     | Shows                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| `/execpolicy status`        | Settings, discovered rule files with rule counts, judge config.     |
| `/execpolicy files`         | Rule files searched, plus parse diagnostics.                        |
| `/execpolicy rules [filter]`| Compiled rules with decision, justification, and source.            |
| `/execpolicy check <cmd>`   | The JSON evaluation, in `codex execpolicy check`'s shape.           |
| `/execpolicy explain <cmd>` | The verdict, deciding layer, reason, and judged segments.           |
| `/execpolicy model [spec]`   | Show or set the execpolicy judge model; independent from `/switch`. |
| `/execpolicy config ...`     | Read/write omp-execpolicy plugin settings.                           |

```console
$ /execpolicy model
judge: @smol → opencode-go/mimo-v2.6-flash

$ /execpolicy model @slow
judge: @slow → anthropic/claude-sonnet-5

$ /execpolicy config set judgeRetries 2
✓ Set judgeRetries
```

`/execpolicy model` controls only the reviewer used by execpolicy. It never
calls omp's session-model switch API, and changing the conversation model with
`/switch` does not change the judge setting. Persistent changes are delegated
to omp's plugin-settings CLI (`omp plugin config ... omp-execpolicy`) using argv
rather than a shell.

```console
$ /execpolicy explain sudo rm -rf /tmp/x
command: sudo rm -rf /tmp/x
decision: prompt
deciding layer: heuristics
reason: Dangerous command (forced rm (rm -f / rm -rf)): sudo rm -rf /tmp/x

evaluated segments:
- sudo rm -rf /tmp/x → rm -rf /tmp/x

matched rules:
- [prompt] heuristics: sudo rm -rf /tmp/x

$ /execpolicy explain cargo build          # default: unmatched = "prompt"
command: cargo build
decision: prompt
deciding layer: unmatched
reason: No execution-policy rule matched this command.

$ /execpolicy explain cargo build          # with unmatched = "none"
command: cargo build
decision: (no opinion — allowed)
deciding layer: none
```

## Settings

Settable in `/settings` → Plugins, or via the environment variable for each key
(environment wins).

| Setting          | Env                              | Default                            | Meaning                                                    |
| ---------------- | -------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `enabled`        | `OMP_EXECPOLICY_ENABLED`         | `true`                             | Judge shell commands at all.                                |
| `ask`            | `OMP_EXECPOLICY_ASK`             | `always`                           | `never` turns `prompt` verdicts into blocks.                |
| `unmatched`      | `OMP_EXECPOLICY_UNMATCHED`       | `prompt`                           | Verdict for commands no rule matched (`none` = no opinion).  |
| `judge`          | `OMP_EXECPOLICY_JUDGE`           | `true`                             | Review every command that needs approval.                   |
| `judgeModel`     | `OMP_EXECPOLICY_JUDGE_MODEL`     | `@smol`                            | `provider/id`, bare id, or a role alias.                    |
| `judgeTimeoutMs` | `OMP_EXECPOLICY_JUDGE_TIMEOUT_MS`| `15000`                            | Per-command judge timeout.                                  |
| `judgeRetries`   | `OMP_EXECPOLICY_JUDGE_RETRIES`   | `1`                                | Extra attempts for empty/malformed verdicts (0–3).           |
| `judgeOnError`   | `OMP_EXECPOLICY_JUDGE_ON_ERROR`  | `ask`                              | `ask` or `allow` when the judge cannot answer.               |
| `judgePolicy`    | `OMP_EXECPOLICY_POLICY`          | *(bundled default)*                | Security policy for the judge: inline text, or a path to a file. |
| `extraRuleFiles` | `OMP_EXECPOLICY_RULES`           | *(none)*                           | Extra `.rules` file(s), comma-separated.                    |
| `amendRules`     | `OMP_EXECPOLICY_AMEND`           | `false`                            | Offer "don't ask again" rule amendments.                    |
| `amendFile`      | `OMP_EXECPOLICY_AMEND_FILE`      | `~/.omp/agent/rules/default.rules` | File an approved "don't ask again" writes to.               |

### "Don't ask again"

With `amendRules = true`, an approval can append an `allow` rule:

```python
prefix_rule(pattern=["rm", "-rf", "/tmp/build"], decision="allow", justification="Approved by the user from the execution-policy prompt.")
```

The amendment is only offered when it would actually make the *whole* command
allowed, and never for a prefix that approves an unbounded command class — bare
`git`, `python`, `bash -c`, `sudo`, `npm run`, and the rest of Codex's
`BANNED_PREFIX_SUGGESTIONS` list are refused, because approving those approves
far more than the command you just read.

## Development

```bash
npm install     # dev-only: TypeScript, node types, harness types
npm test        # node --test "test/*.test.ts"
npm run typecheck
```

`node_modules/` is git-ignored and is **not** needed at runtime — omp supplies
its own host modules when it loads the extension. It exists only so `tsc` and
`node --test` have the harness types on hand.

Tests cover decomposition and unwrapping, rule parsing and diagnostics, the
matching order (including host-executable restrictions), the verdict pipeline,
judge-response parsing, and every `/execpolicy` renderer.

Two invariants are pinned rather than left to prose, because both were wrong at
some point during development and neither failure is visible from the UI:

- **Example validation is per declaration**, not per expanded rule: one
  `pattern = [["npm", "pnpm"]]` declaration expands into two rules, and each
  `match` example belongs to the declaration, so `npm install` must not be
  required to match the `pnpm` variant.
- **Heredoc bodies are not commands.** `cat <<EOF ... EOF` contributes `cat`
  only; judging the body flags prose that merely mentions a command.

## Layout

| File                | Role                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `src/index.ts`      | Extension entry: gates `bash`, owns session approvals.                    |
| `src/policy.ts`     | Rule index, matching order, evaluation aggregation.                       |
| `src/rules.ts`      | `.rules` parser and amendment rendering.                                  |
| `src/command.ts`    | Command decomposition and wrapper unwrapping.                             |
| `src/dangerous.ts`  | Dangerous-command heuristics.                                             |
| `src/gate.ts`       | The verdict pipeline and prompt/amendment planning.                        |
| `src/judge.ts`      | Model reviewer; `src/verdict.ts` parses its response.                      |
| `src/prompt.ts`     | Judge prompt and the default security policy.                             |
| `src/store.ts`      | Harness-bound state cache (settings + parsed rules, mtime-invalidated).    |
| `src/settings.ts`   | Settings resolution, no harness imports.                                   |
| `src/rule-files.ts` | Rule-file discovery and amendment writes.                                  |
| `src/slash-command.ts` | `/execpolicy`.                                                          |
| `src/transcript.ts` | Bounded transcript digest for the judge.                                  |

## Relationship to Codex

| Codex                            | Here                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `codex-execpolicy` rules          | `src/rules.ts` + `src/policy.ts` (same `.rules` syntax)   |
| `is_dangerous_command.rs`         | `src/dangerous.ts`                                        |
| Guardian / auto-review            | `src/judge.ts` + `src/prompt.ts`                          |
| `GuardianReviewMode` (per scope)  | the `judge` setting (`Shell` is the only scope here)      |
| `ExecApprovalRequirement`         | `DeterministicVerdict` in `src/gate.ts`                   |
| `codex execpolicy check`          | `/execpolicy check`                                       |
| `BANNED_PREFIX_SUGGESTIONS`       | `BANNED_AMENDMENT_PREFIXES` in `src/gate.ts`              |

Deliberate differences: this plugin has no sandbox to pair verdicts with, so an
`allow` verdict only skips the prompt (Codex additionally decides whether to
bypass its sandbox); and it gates omp's `bash` tool, not a shell-exec subsystem,
so `network_rule` is not implemented.
