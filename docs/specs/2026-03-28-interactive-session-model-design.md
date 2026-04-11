# Interactive Session Model for tmup

**Date:** 2026-03-28
**Status:** Draft
**Problem:** Agents using tmup default to exec/one-shot thinking because the skill, agent, and MCP tool documentation never explicitly teaches the interactive-session + send-keys mental model.

---

## Problem Statement

The tmup runtime is correct: `dispatch-agent.sh` spawns codex as a foreground interactive process in tmux panes, `tmux-helpers.sh` drives them with `send-keys -l` plus idle/shell guards. But the documentation layers — SKILL.md, REFERENCE.md, MCP tool descriptions, and consuming agent definitions — describe tools abstractly ("dispatch", "reprompt") without teaching the underlying model. Agents default to exec/one-shot patterns because nothing tells them otherwise.

## Approach

Defense in depth: teach the interactive-session model once at the skill level, reinforce it in MCP tool descriptions and consuming agent definitions. The model is fundamental enough to warrant intentional duplication across instruction surfaces.

## Priority

| Priority | Files |
|----------|-------|
| P0 (the actual fix) | `skills/tmup/SKILL.md`, `skills/tmup/REFERENCE.md`, `mcp-server/src/tools/index.ts`, `crossmodel-supervisor.md`, `sdlc-crossmodel/SKILL.md` |
| P1 (useful reinforcement) | `tmup_dispatch` response fields, `commands/tmup.md` |
| P2 (nice-to-have) | `README.md`, `docs/API.md` |

---

## Section 1: tmup SKILL.md — Interactive Session Model

**File:** `/Users/q/.claude/plugins/tmup/skills/tmup/SKILL.md`
**Location:** New section inserted before the "MCP Tools (Lead)" table (before line 18).

### Content

```markdown
## Interactive Session Model

tmup workers are long-lived interactive Codex sessions inside existing tmux panes. They are NOT one-shot `codex exec` commands.

Before dispatch, a pane is just a shell. After dispatch, the pane hosts a live Codex session until that process exits.

| Tool | What it does | Underlying mechanism |
|------|-------------|---------------------|
| `tmup_dispatch` | Start or resume an interactive Codex session in a pane | Sends a launcher script into an existing pane via `tmux send-keys`; the launcher starts or resumes codex as a foreground process |
| `tmup_reprompt` | Send follow-up text into that existing session | `tmux send-keys -l` (literal mode) with guards: agent must be idle or explicitly queueable ("tab to queue" visible), pane must not be at shell prompt, text verified in scrollback before double-Enter submission |
| `tmup_harvest` | Read pane scrollback — observation only | `tmux capture-pane`; returns codex_session_id and resume_command if available |

### Anti-Patterns

- Do NOT run `codex exec "prompt"` via Bash — workers are interactive, not one-shot
- Do NOT type shell commands directly into worker panes
- Do NOT treat each prompt as a fresh codex process
- Do NOT use Bash tool to drive pane content
- Do NOT use `tmup_harvest` as the primary way to communicate with workers — harvest is observational, not conversational

### Correct Patterns

- `tmup_dispatch` once per worker to start or resume that worker's interactive session
- `tmup_reprompt` to continue, redirect, or nudge an existing idle or queueable session
- `tmup_harvest` to inspect pane state or recover a session ID
- `tmup_dispatch` with `resume_session_id` to relaunch a crashed worker into a resumed Codex session
```

---

## Section 2: tmup REFERENCE.md — Interactive Session Rule

**File:** `/Users/q/.claude/plugins/tmup/skills/tmup/REFERENCE.md`
**Location:** New section inserted at the top of the "MCP Tools" area (after line 7, before `### tmup_init`).

### Content

```markdown
## Interactive Session Rule

All workers are interactive Codex sessions in tmux panes. Use `tmup_dispatch` to start sessions, `tmup_reprompt` to send follow-up text into them, `tmup_harvest` to observe. Never use `codex exec` or Bash to drive panes.
```

### tmup_dispatch description update

**Current (line ~90):**
```
Registers agent, claims task, and launches Codex process atomically.
```

**New:**
```
Registers agent, claims task, and launches an interactive Codex session in a pane. The session persists until the codex process exits. Follow-up communication goes through `tmup_reprompt`, not by running additional commands in the pane.
```

### tmup_reprompt description update

**Current (line ~108):**
```
Send a follow-up prompt to a running agent. Harvests pane output first (configurable).
```

**New:**
```
Send follow-up text to a running interactive session via `tmux send-keys -l` (literal mode). Guards: agent must be idle or explicitly queueable ("tab to queue" visible), pane must be hosting a Codex session (not at a bare shell prompt), text is verified in scrollback before double-Enter submission.
```

### tmup_dispatch example response update

**Current:**
```json
{"ok": true, "agent_id": "uuid", "pane_index": 2, "launched": true,
 "launch_output": "Dispatched implementer to pane 2 (agent uuid)"}
```

**New:**
```json
{"ok": true, "agent_id": "uuid", "pane_index": 2, "launched": true,
 "session_mode": "interactive", "follow_up_via": "tmup_reprompt",
 "launch_output": "Dispatched implementer to pane 2 (agent uuid)"}
```

---

## Section 3: crossmodel-supervisor.md — Pane Interaction Model

**File:** `/Users/q/.claude/plugins/sdlc-os/agents/crossmodel-supervisor.md`
**Location:** New section inserted after the "Chain of Command" block (after line 15, before "State Machine").

### Content

```markdown
## Pane Interaction Model

Workers are interactive Codex sessions, not one-shot commands. After `tmup_dispatch` creates a session, the pane hosts a live codex process. All follow-up instructions go through `tmup_reprompt` (which sends keystrokes into the session via tmux send-keys).

**Do not:**
- Run `codex exec` or Bash commands in worker panes
- Use `tmup_harvest` to communicate (it is read-only observation)
- Treat dispatch as fire-and-forget — monitor via the status/inbox/next_action loop
```

---

## Section 4: sdlc-crossmodel SKILL.md — Session Control Subsection

**File:** `/Users/q/.claude/plugins/sdlc-os/skills/sdlc-crossmodel/SKILL.md`
**Location:** New subsection added within the existing "tmup MCP Tool Usage" section (after line 186, before "Deterministic Scripts"). The existing tool-usage table is preserved; this subsection adds the session-control model.

### Content

```markdown
### Session Control Model

Workers dispatched via `tmup_dispatch` are persistent interactive Codex sessions, not one-shot commands. The pane hosts a live codex process from dispatch until exit.

| Tool | Session role | What it is NOT |
|---|---|---|
| `tmup_dispatch` | Start or resume a persistent interactive session in a pane | Not a fire-and-forget exec call |
| `tmup_reprompt` | Send follow-up text to an idle or queueable session via send-keys | Not a new command or process launch |
| `tmup_harvest` | Read pane scrollback — observation only | Not a communication channel to the worker |

Do not run `codex exec`, Bash commands, or any direct shell interaction in worker panes. All follow-up text into a worker's interactive pane goes through `tmup_reprompt`. Structured inter-agent messaging uses `tmup_send_message` / `tmup_inbox` separately.
```

---

## Section 5: MCP Tool Descriptions (index.ts)

**File:** `/Users/q/.claude/plugins/tmup/mcp-server/src/tools/index.ts`

### tmup_dispatch description (line 237)

**Current:**
```typescript
description: 'Dispatch a Codex worker to a tmux pane. Registers agent, claims task, and launches Codex process atomically.',
```

**New:**
```typescript
description: 'Start or resume an interactive Codex session in a tmux pane. The session persists until the process exits. Registers agent and claims task atomically. Use tmup_reprompt for follow-up communication, not Bash or codex exec.',
```

### tmup_reprompt description (line 289)

**Current:**
```typescript
description: 'Send a follow-up prompt to a running agent. Harvests pane output first, then sends the new prompt via tmux. Only sends to idle agents (not actively working).',
```

**New:**
```typescript
description: 'Send follow-up text into a running interactive Codex session via tmux send-keys (literal mode). Guarded: agent must be idle or queueable, pane must host a session (not bare shell). This is the only way to send text into the worker pane. Structured messaging uses tmup_send_message separately.',
```

### tmup_dispatch response (line 733)

**Current:**
```typescript
return json({
  ok: true,
  agent_id: agentId,
  task_id: taskId,
  pane_index: paneIndex ?? 'auto',
  role,
  subject: task.subject,
  description: task.description,
  launched: true,
  launch_output: launchResult,
});
```

**New (add two fields):**
```typescript
return json({
  ok: true,
  agent_id: agentId,
  task_id: taskId,
  pane_index: paneIndex ?? 'auto',
  role,
  subject: task.subject,
  description: task.description,
  launched: true,
  session_mode: 'interactive',
  follow_up_via: 'tmup_reprompt',
  launch_output: launchResult,
});
```

### Test update required

**File:** `/Users/q/.claude/plugins/tmup/tests/mcp/handle-tool-call.test.ts`

Any test asserting on the `tmup_dispatch` response shape must be updated to include `session_mode: 'interactive'` and `follow_up_via: 'tmup_reprompt'` in the expected output.

---

## Section 6 (P1): commands/tmup.md — Reinforcement

**File:** `/Users/q/.claude/plugins/tmup/commands/tmup.md`
**Location:** After the "Workflow" section (after line 64).

### Content

```markdown
> **Session model:** Workers are interactive Codex sessions in tmux panes.
> Use `tmup_dispatch` to start them, `tmup_reprompt` to send follow-up
> instructions. Never use `codex exec` or Bash to drive worker panes.
```

---

## Implementation Follow-Through

### Contract change: dispatch response fields

Adding `session_mode` and `follow_up_via` to the dispatch response is an additive contract change. Required updates:

1. `mcp-server/src/tools/index.ts:733` — add fields to response object
2. `skills/tmup/REFERENCE.md:89` — update example response
3. `tests/mcp/handle-tool-call.test.ts` — update dispatch response assertions

### Guard accuracy

All documentation must describe the reprompt guard as "idle or explicitly queueable" (not just "idle"), matching the actual behavior in `scripts/lib/tmux-helpers.sh:60-62` where "Working (" is busy UNLESS "tab to queue" is present in scrollback.

---

## Files Changed (Summary)

| File | Change type |
|------|------------|
| `~/.claude/plugins/tmup/skills/tmup/SKILL.md` | Add Interactive Session Model section |
| `~/.claude/plugins/tmup/skills/tmup/REFERENCE.md` | Add Interactive Session Rule heading + update tool descriptions |
| `~/.claude/plugins/tmup/mcp-server/src/tools/index.ts` | Update dispatch/reprompt descriptions + add response fields |
| `~/.claude/plugins/tmup/tests/mcp/handle-tool-call.test.ts` | Update dispatch response assertions |
| `~/.claude/plugins/sdlc-os/agents/crossmodel-supervisor.md` | Add Pane Interaction Model section |
| `~/.claude/plugins/sdlc-os/skills/sdlc-crossmodel/SKILL.md` | Add Session Control Model subsection |
| `~/.claude/plugins/tmup/commands/tmup.md` | Add session model note |

---

## Out of Scope

- README.md and docs/API.md updates (P2, not where agent behavior breaks)
- Changes to dispatch-agent.sh or tmux-helpers.sh (runtime is already correct)
- Changes to worker agent definitions (implementer.md, etc.) — they receive the model through the prompt constructed by dispatch-agent.sh
