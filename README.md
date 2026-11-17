# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with elapsed time and progress. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)    8 msgs (5.1KB)   │
│ 00:45  Scout: DB (scout)     12 msgs (9.3KB)   │
╰─────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/NigelThorne/pi-interactive-subagents
```

Supported multiplexers:

- [cmux](https://github.com/manaflow-ai/cmux)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)

Start pi inside one of them:

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
```

Optional: set `PI_SUBAGENT_MUX=cmux|tmux|zellij` to force a specific backend. Inside a real tmux pane, `TMUX` plus `TMUX_PANE` takes precedence over inherited cmux variables unless an available backend is explicitly forced. Set `PI_SUBAGENT_TMUX_EXECUTABLE` when tmux is not on `PATH`.

The tmux backend uses the socket path from `TMUX`, targets the parent pane by its stable `%N` ID, starts the child command during `split-window`, and creates the split detached. Switching to another window while a launch starts does not redirect the child or steal focus. Status checks require both pane ancestry and the expected Pi session path before reporting a child as running.

## What's Included

### Extensions

**Subagents** — 6 tools + 4 commands:

| Tool              | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `subagent`        | Spawn a sub-agent in a dedicated multiplexer pane (async, returns immediately) |
| `subagent_status` | Show tracked-child status, or discover all registered local sessions with `scope: "all"` |
| `subagent_steer`  | Send a follow-up instruction to an explicitly identified live Pi session       |
| `subagents_list`  | List available agent definitions                                                |
| `set_tab_title`   | Update pane or window titles to show progress (tmux and Zellij)                 |
| `subagent_resume` | Resume a previous sub-agent session (async); follow-up messages auto-append finish instructions |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |
| `/subagent_status`        | Show verified status without an AI turn |

Run `/subagent_status` to check the current parent's tracked subagents without an AI turn. It displays the same report as the tool. After updating the extension, run `/reload` to load the changes.

`lifecycle=running` means the Pi process is alive. Check `activity` separately:

- `processing`: Pi reports an active agent run.
- `idle`: Pi reports no active run. This does not mean the assignment is complete.
- `unknown`: activity cannot be confirmed.

Activity comes from the optional `pi-session-manager-presence` snapshot in `~/.pi/agent/session-manager/live/`. It must match the child session ID, session path, and sole verified Pi PID, and be no older than 45 seconds. Missing, stale, or mismatched records report `unknown`. `activityObservedAgo` is the age of that observation, not time spent idle. Presence never changes completion, steering, or cleanup behaviour.

**Session Artifacts** — 2 tools for session-scoped file storage:

| Tool             | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `write_artifact` | Write plans, context, notes to a session-scoped directory |
| `read_artifact`  | Read artifacts from current or previous sessions          |

### Bundled Agents

| Agent             | Model                  | Role                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Codex GPT-5.4          | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Codex GPT-5.4          | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Codex GPT-5.4          | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Codex GPT-5.4          | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Codex GPT-5.4          | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

Agent discovery follows priority: nearest **project-local** (`.pi/agents/`) > **version-controlled user** (`~/.my-pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Definitions are keyed by frontmatter `name`, not filename. Override any bundled agent by placing your own definition in a higher-priority location.

---

## Async Subagent Flow

```
1. Agent calls subagent()         → returns immediately ("started")
2. Sub-agent starts in a mux pane → widget tracks it
3. subagent_status verifies pane, Pi process, and done-file state
4. Sub-agent finishes              → result steered back as interrupt
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ──────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)      15 msgs (12KB) │
│ 00:45  Researcher (researcher)   8 msgs (6KB)  │
│ 00:12  Scout: DB (scout)             starting…  │
╰─────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Fork — sub-agent gets full conversation context
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Override agent defaults
subagent({
  name: "Worker",
  agent: "worker",
  model: "anthropic/claude-haiku-4-5",
  task: "Quick fix...",
});

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter      | Type    | Default  | Description                                                             |
| -------------- | ------- | -------- | ----------------------------------------------------------------------- |
| `name`         | string  | required | Display name (shown in widget and pane title)                           |
| `task`         | string  | required | Task prompt for the sub-agent                                           |
| `agent`        | string  | —        | Load defaults from agent definition                                     |
| `fork`         | boolean | `false`  | Copy current session for full context                                   |
| `model`        | string  | —        | Override agent's default model                                          |
| `systemPrompt` | string  | —        | Append to system prompt                                                 |
| `skills`       | string  | —        | Comma-separated skill names                                             |
| `tools`        | string  | —        | Comma-separated tool names                                              |
| `cwd`          | string  | —        | Working directory for the sub-agent (see [Role Folders](#role-folders)) |

---

## Steering a running subagent

Use `subagent_steer` to send an instruction to any explicitly identified live local Pi session, including a session not launched by the caller. It delivers through the receiver's private local endpoint and Pi message API; it does not type into a terminal, resume a session, or create another pane.

```typescript
subagent_steer({
  // Prefer a stable identifier from the launch result. Pane titles may change.
  target: launchResult.details.sessionId,
  message: "Stop the current approach and inspect the failing test first.",
});
```

The target may be a caller-local launch `id`, an exact registered Pi `sessionId` or `sessionFile` path, or an unambiguous registered launch-name alias. A title set with `set_tab_title` is not an identifier. Use `subagent_status({ scope: "all" })` to discover registered live sessions; the default remains the caller's tracked children.

The receiver derives whether the sender is its parent by comparing the sender's runtime session identity with parent lineage recorded in the receiver's own session header. Message prose and sender-supplied role claims cannot set that label. A resumed session keeps its recorded creation lineage. Fork lineage also comes from the new session header; this steering change does not alter how the launcher creates forks. Missing, stale, duplicate, or ambiguous routes fail closed, and success means the receiver acknowledged that Pi accepted the message for delivery, not that the model acted on it.

Wire compatibility: requests and ACKs are newline-framed, so the ACK no longer depends on half-open sockets (Pi 1.1.0 drops them). New senders keep the socket open for the ACK and half-close only if no ACK arrives within 300 ms, which lets older receivers still process the request. Older senders, including psc's own client, still half-close, so their ACK stays lost on Pi 1.1.0 until they adopt newline framing.

| Sender → Receiver | Delivered | ACK |
| --- | --- | --- |
| new → new | yes | yes, including Pi 1.1.0 |
| old → new | yes | only where half-open works (not Pi 1.1.0) |
| new → old | yes | may be lost on Pi 1.1.0, as before |
| old → old | yes | unchanged |

This is a same-user local transport. Its file permissions and runtime metadata provide routing provenance, not cryptographic authentication against another process running as the same OS user. Existing Pi sessions must `/reload` before they register an endpoint.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

Tab/window titles update to show current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This forks the current session into a subagent with full conversation context. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: balanced
thinking: minimal
tools: read, bash, edit, write
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Default concrete model or local category alias: `fast`, `balanced`, or `deep`                                                                                                                                                                                               |
| `thinking`    | string  | Thinking level: `minimal`, `medium`, `high`                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated tool allowlist, including extension tools. `subagent_done` is always added.                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `auto-exit`   | boolean | Shut down when the unattended task settles, including errors and blockers. Steering does not disable auto-exit. Use false for interactive agents. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |

### Model categories

Agent definitions and the `model` launch override may use `fast`, `balanced`, or `deep` instead of a provider-specific model. Category choices live outside model context in `~/.pi/agent/model-categories.json`; the parent asks before saving a missing or unavailable mapping and never guesses or ranks models. Concrete model strings remain supported and always bypass category mappings.

Migration is opt-in: replace a concrete `model:` value with, for example, `model: balanced` or `model: deep`. Existing definitions do not need to change, and no profile is created until a category is selected interactively.

---

### `subagent_resume`

When `subagent_resume` is given a follow-up `message`, that message is automatically wrapped with completion instructions so the resumed agent knows how to hand control back.

**Behavior:**

- The original follow-up request is preserved.
- A nonempty follow-up enables `PI_SUBAGENT_AUTO_EXIT=1` in the child and auto-exit tracking in the parent.
- A resume without a follow-up is interactive and explicitly disables auto-exit.
- Follow-up instructions request a summary and `subagent_done`, but shutdown does not depend on the model obeying.

### `auto-exit`

When set to `true`, the child runs unattended and exits when Pi settles. A `subagent_done` call is preferred but not required.

- Shutdown waits for retries, compaction and queued follow-ups. A session-owned idle check covers missed completion events.
- Steering does not turn an unattended child into an interactive session.
- The parent ignores trailing telemetry when checking settled events from the current launch. It gives graceful shutdown three seconds before closing a stuck child pane.
- Process exit and task success are separate. Automatic final responses are labelled `reported`, not `completed`. Errors, aborts and missing results are failures. `subagent_done` accepts `status: completed | blocked | failed` plus a summary.
- New parent sessions or `/reload` load launcher changes. Existing children keep their loaded code; this update does not restart them.

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all spawning tools (`subagent`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent, set_tab_title
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij
```

## Verification

- `npm test` runs unit and isolated tmux tests.
- `npm run test:pi` requires an installed Pi with `agent_settled` support. It runs real Pi processes in RPC mode with a synthetic offline provider, temporary configuration and no credentials. It checks fresh/resumed auto-exit, queued follow-ups, failures and the restricted completion-tool allowlist.

## License

MIT
