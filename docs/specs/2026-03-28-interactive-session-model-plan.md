# Interactive Session Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the interactive-session + send-keys mental model to all tmup consumers so agents stop defaulting to exec/one-shot patterns.

**Architecture:** Documentation-first change across 7 files (skill, reference, MCP tool descriptions, consuming agent/skill definitions) plus one additive response field change in index.ts. No runtime behavior changes — the shell scripts are already correct.

**Tech Stack:** Markdown (skills/agents), TypeScript (MCP server), Vitest (tests), esbuild (bundler)

**Spec:** `docs/specs/2026-03-28-interactive-session-model-design.md`

---

### Task 1: Add Interactive Session Model to tmup SKILL.md

**Files:**
- Modify: `skills/tmup/SKILL.md:17` (insert before "## MCP Tools (Lead)")

- [ ] **Step 1: Insert the Interactive Session Model section**

In `skills/tmup/SKILL.md`, insert the following block immediately before the line `## MCP Tools (Lead)` (currently line 18):

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

- [ ] **Step 2: Verify the file reads correctly**

Read `skills/tmup/SKILL.md` and confirm the new section appears between "Quick Start" and "MCP Tools (Lead)" with no formatting issues.

- [ ] **Step 3: Commit**

```bash
cd /Users/q/.claude/plugins/tmup
git add skills/tmup/SKILL.md
git commit -m "docs(skill): add Interactive Session Model section to SKILL.md

Teaches the interactive-session + send-keys mental model before the tool
reference so agents learn the model before seeing the tools. Includes
anti-patterns (codex exec, Bash in panes) and correct patterns."
```

---

### Task 2: Add Interactive Session Rule and update tool descriptions in REFERENCE.md

**Files:**
- Modify: `skills/tmup/REFERENCE.md:8` (insert before `### tmup_init`)
- Modify: `skills/tmup/REFERENCE.md:89-98` (tmup_dispatch description)
- Modify: `skills/tmup/REFERENCE.md:107-120` (tmup_reprompt description)

- [ ] **Step 1: Insert the Interactive Session Rule heading**

In `skills/tmup/REFERENCE.md`, insert the following block between `## MCP Tools` (line 8) and `### tmup_init` (line 10):

```markdown
## Interactive Session Rule

All workers are interactive Codex sessions in tmux panes. Use `tmup_dispatch` to start sessions, `tmup_reprompt` to send follow-up text into them, `tmup_harvest` to observe. Never use `codex exec` or Bash to drive panes.
```

- [ ] **Step 2: Update the tmup_dispatch entry**

Replace the current tmup_dispatch block (lines 89-98):

```markdown
### tmup_dispatch
Registers agent, claims task, and launches Codex process atomically.
```json
{"task_id": "003", "role": "implementer",
 "pane_index?": 2, "working_dir?": "/path", "resume_session_id?": "codex-session-abc"}
→ {"ok": true, "agent_id": "uuid", "pane_index": 2, "launched": true,
   "launch_output": "Dispatched implementer to pane 2 (agent uuid)"}
```

With `resume_session_id`, uses `codex resume <ID>` instead of fresh launch.
```

With:

```markdown
### tmup_dispatch
Registers agent, claims task, and launches an interactive Codex session in a pane. The session persists until the codex process exits. Follow-up communication goes through `tmup_reprompt`, not by running additional commands in the pane.
```json
{"task_id": "003", "role": "implementer",
 "pane_index?": 2, "working_dir?": "/path", "resume_session_id?": "codex-session-abc"}
→ {"ok": true, "agent_id": "uuid", "pane_index": 2, "launched": true,
   "session_mode": "interactive", "follow_up_via": "tmup_reprompt",
   "launch_output": "Dispatched implementer to pane 2 (agent uuid)"}
```

With `resume_session_id`, uses `codex resume <ID>` instead of fresh launch.
```

- [ ] **Step 3: Update the tmup_reprompt entry**

Replace the current tmup_reprompt block (lines 107-120):

```markdown
### tmup_reprompt
Send a follow-up prompt to a running agent. Harvests pane output first (configurable).
```json
{"pane_index": 3, "prompt": "Now implement the error handling for edge cases",
 "harvest_first?": true, "all?": false}
→ {"ok": true, "pane_index": 3, "output": "Pane 3: sent",
   "harvested_before_reprompt": "...scrollback..."}
```

Safety guards:
- Only sends to idle agents (not actively "Working")
- Rejects shell prompts (pane must have running agent)
- Uses literal mode (`-l`) to prevent prompt text from triggering key events
- Double-Enter submission for reliable input
```

With:

```markdown
### tmup_reprompt
Send follow-up text to a running interactive session via `tmux send-keys -l` (literal mode). This is the only way to send text into the worker's interactive pane. Structured inter-agent messaging uses `tmup_send_message` separately.
```json
{"pane_index": 3, "prompt": "Now implement the error handling for edge cases",
 "harvest_first?": true, "all?": false}
→ {"ok": true, "pane_index": 3, "output": "Pane 3: sent",
   "harvested_before_reprompt": "...scrollback..."}
```

Safety guards:
- Agent must be idle or explicitly queueable ("tab to queue" visible in scrollback)
- Rejects shell prompts (pane must be hosting a Codex session, not at bare shell)
- Uses literal mode (`-l`) to prevent prompt text from triggering key events
- Text verified in scrollback before double-Enter submission
```

- [ ] **Step 4: Verify the file reads correctly**

Read `skills/tmup/REFERENCE.md` and confirm: Interactive Session Rule heading appears before tmup_init, dispatch entry mentions interactive session and shows `session_mode`/`follow_up_via` in response, reprompt entry mentions send-keys and queueable guard.

- [ ] **Step 5: Commit**

```bash
cd /Users/q/.claude/plugins/tmup
git add skills/tmup/REFERENCE.md
git commit -m "docs(reference): add Interactive Session Rule and update tool descriptions

Adds heading-level session rule. Updates tmup_dispatch description to say
'interactive Codex session' and adds session_mode/follow_up_via to example
response. Updates tmup_reprompt to mention send-keys mechanism and
idle-or-queueable guard."
```

---

### Task 3: Update MCP tool descriptions in index.ts

**Files:**
- Modify: `mcp-server/src/tools/index.ts:237` (tmup_dispatch description)
- Modify: `mcp-server/src/tools/index.ts:289` (tmup_reprompt description)

- [ ] **Step 1: Update tmup_dispatch description**

In `mcp-server/src/tools/index.ts`, replace line 237:

```typescript
    description: 'Dispatch a Codex worker to a tmux pane. Registers agent, claims task, and launches Codex process atomically.',
```

With:

```typescript
    description: 'Start or resume an interactive Codex session in a tmux pane. The session persists until the process exits. Registers agent and claims task atomically. Use tmup_reprompt for follow-up communication, not Bash or codex exec.',
```

- [ ] **Step 2: Update tmup_reprompt description**

In `mcp-server/src/tools/index.ts`, replace line 289:

```typescript
    description: 'Send a follow-up prompt to a running agent. Harvests pane output first, then sends the new prompt via tmux. Only sends to idle agents (not actively working).',
```

With:

```typescript
    description: 'Send follow-up text into a running interactive Codex session via tmux send-keys (literal mode). Guarded: agent must be idle or queueable, pane must host a session (not bare shell). This is the only way to send text into the worker pane. Structured messaging uses tmup_send_message separately.',
```

- [ ] **Step 3: Verify edits**

Read `mcp-server/src/tools/index.ts` lines 235-300 and confirm both descriptions are updated without syntax errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/q/.claude/plugins/tmup
git add mcp-server/src/tools/index.ts
git commit -m "fix(mcp): update dispatch/reprompt tool descriptions to teach interactive model

tmup_dispatch now says 'interactive Codex session' and directs to
tmup_reprompt for follow-up. tmup_reprompt now says 'send-keys' and
'idle or queueable'."
```

---

### Task 4: Add session_mode and follow_up_via to dispatch response

**Files:**
- Modify: `mcp-server/src/tools/index.ts:733` (dispatch response object)

- [ ] **Step 1: Add the two fields to the dispatch response**

In `mcp-server/src/tools/index.ts`, find the dispatch response object (around line 733):

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

Replace with:

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

- [ ] **Step 2: Verify the edit**

Read `mcp-server/src/tools/index.ts` lines 730-745 and confirm `session_mode` and `follow_up_via` appear before `launch_output`.

- [ ] **Step 3: Commit**

```bash
cd /Users/q/.claude/plugins/tmup
git add mcp-server/src/tools/index.ts
git commit -m "feat(mcp): add session_mode and follow_up_via to dispatch response

Additive contract change: dispatch now returns session_mode: 'interactive'
and follow_up_via: 'tmup_reprompt' as in-band hints for consuming agents."
```

---

### Task 5: Update dispatch test assertions

**Files:**
- Modify: `tests/mcp/handle-tool-call.test.ts:168-177` (success response assertion)

- [ ] **Step 1: Update the success response assertion**

In `tests/mcp/handle-tool-call.test.ts`, find the dispatch success test (around line 168):

```typescript
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        task_id: taskId,
        pane_index: 2,
        role: 'tester',
        subject: 'Dispatch subject',
        description: 'Dispatch description',
        launched: true,
        launch_output: 'launched pane 2',
      }));
```

Replace with:

```typescript
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        task_id: taskId,
        pane_index: 2,
        role: 'tester',
        subject: 'Dispatch subject',
        description: 'Dispatch description',
        launched: true,
        session_mode: 'interactive',
        follow_up_via: 'tmup_reprompt',
        launch_output: 'launched pane 2',
      }));
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/q/.claude/plugins/tmup && npm test
```

Expected: All tests pass, including the updated dispatch assertion.

- [ ] **Step 3: Commit**

```bash
cd /Users/q/.claude/plugins/tmup
git add tests/mcp/handle-tool-call.test.ts
git commit -m "test(mcp): update dispatch response assertion for new session fields

Adds session_mode: 'interactive' and follow_up_via: 'tmup_reprompt'
to the expected dispatch response in the success test."
```

---

### Task 6: Rebuild MCP server dist

**Files:**
- Regenerate: `mcp-server/dist/index.js`, `mcp-server/dist/tools/index.js`, `mcp-server/dist/tools/index.d.ts`

- [ ] **Step 1: Run the build**

```bash
cd /Users/q/.claude/plugins/tmup && npm run build --workspace=mcp-server
```

Expected: `tsc --noEmit` passes (no type errors), esbuild produces `mcp-server/dist/index.js`.

- [ ] **Step 2: Verify dist files are updated**

```bash
cd /Users/q/.claude/plugins/tmup
grep -c 'session_mode' mcp-server/dist/index.js
grep -c 'follow_up_via' mcp-server/dist/index.js
grep -c 'interactive Codex session' mcp-server/dist/tools/index.js
```

Expected: Each grep returns at least 1 match.

- [ ] **Step 3: Commit the rebuilt dist**

```bash
cd /Users/q/.claude/plugins/tmup
git add mcp-server/dist/
git commit -m "build(mcp): regenerate dist after tool description and response changes"
```

---

### Task 7: Add Pane Interaction Model to crossmodel-supervisor.md

**Files:**
- Modify: `/Users/q/.claude/plugins/sdlc-os/agents/crossmodel-supervisor.md:16` (insert before "## State Machine")

- [ ] **Step 1: Insert the Pane Interaction Model section**

In `crossmodel-supervisor.md`, insert the following block between `- You produce: session journal + validated artifacts + normalized findings` (line 15) and `## State Machine` (line 17):

```markdown
## Pane Interaction Model

Workers are interactive Codex sessions, not one-shot commands. After `tmup_dispatch` creates a session, the pane hosts a live codex process. All follow-up text into the worker's pane goes through `tmup_reprompt` (which sends keystrokes into the session via tmux send-keys). Structured inter-agent messaging uses `tmup_send_message` / `tmup_inbox` separately.

**Do not:**
- Run `codex exec` or Bash commands in worker panes
- Use `tmup_harvest` to communicate (it is read-only observation)
- Treat dispatch as fire-and-forget — monitor via the status/inbox/next_action loop
```

- [ ] **Step 2: Verify the file reads correctly**

Read `crossmodel-supervisor.md` lines 15-30 and confirm the new section sits between Chain of Command and State Machine.

- [ ] **Step 3: Commit**

```bash
cd /Users/q/.claude/plugins/sdlc-os
git add agents/crossmodel-supervisor.md
git commit -m "docs(agent): add Pane Interaction Model to crossmodel-supervisor

Teaches the supervisor that workers are interactive sessions driven
via send-keys, not one-shot exec commands. Includes explicit anti-patterns."
```

---

### Task 8: Add Session Control Model subsection to sdlc-crossmodel SKILL.md

**Files:**
- Modify: `/Users/q/.claude/plugins/sdlc-os/skills/sdlc-crossmodel/SKILL.md:186` (insert after the existing tool-usage table, before "## Deterministic Scripts")

- [ ] **Step 1: Insert the Session Control Model subsection**

In `sdlc-crossmodel/SKILL.md`, insert the following block between the tool-usage table closing `|` row (line 185) and `---` / `## Deterministic Scripts` (lines 187-189):

```markdown

### Session Control Model

Workers dispatched via `tmup_dispatch` are persistent interactive Codex sessions, not one-shot commands. The pane hosts a live codex process from dispatch until exit.

| Tool | Session role | What it is NOT |
|---|---|---|
| `tmup_dispatch` | Start or resume a persistent interactive session in a pane | Not a fire-and-forget exec call |
| `tmup_reprompt` | Send follow-up text to an idle or queueable session via send-keys | Not a new command or process launch |
| `tmup_harvest` | Read pane scrollback — observation only | Not a communication channel to the worker |

Do not run `codex exec`, Bash commands, or any direct shell interaction in worker panes. All follow-up text into the worker's pane goes through `tmup_reprompt`. Structured inter-agent messaging uses `tmup_send_message` / `tmup_inbox` separately.
```

- [ ] **Step 2: Verify the file reads correctly**

Read `sdlc-crossmodel/SKILL.md` lines 173-200 and confirm the existing tool-usage table is preserved and the new Session Control Model subsection appears after it, before Deterministic Scripts.

- [ ] **Step 3: Commit**

```bash
cd /Users/q/.claude/plugins/sdlc-os
git add skills/sdlc-crossmodel/SKILL.md
git commit -m "docs(skill): add Session Control Model to sdlc-crossmodel

Adds session-control subsection to the existing tool-usage section.
Preserves the original Does/Does-NOT table. Teaches the interactive
session model with anti-patterns."
```

---

### Task 9: Add session model note to commands/tmup.md

**Files:**
- Modify: `commands/tmup.md:64` (insert after the Workflow section)

- [ ] **Step 1: Insert the session model note**

In `commands/tmup.md`, insert the following block between the Workflow list item 5 (line 63) and `## Task DAG` (line 65):

```markdown

## Session Model

Workers are interactive Codex sessions in tmux panes. Use `tmup_dispatch` to start them, `tmup_reprompt` to send follow-up instructions. Never use `codex exec` or Bash to drive worker panes.
```

- [ ] **Step 2: Verify the file reads correctly**

Read `commands/tmup.md` lines 57-75 and confirm the new section appears between Workflow and Task DAG.

- [ ] **Step 3: Commit**

```bash
cd /Users/q/.claude/plugins/tmup
git add commands/tmup.md
git commit -m "docs(command): add session model note to /tmup command

Reinforces the interactive session model in the slash command docs
so users who invoke /tmup get the correct mental model."
```

---

### Task 10: Final verification

**Files:**
- Read-only verification across all changed files

- [ ] **Step 1: Run tmup tests**

```bash
cd /Users/q/.claude/plugins/tmup && npm test
```

Expected: All tests pass.

- [ ] **Step 2: Verify the build is clean**

```bash
cd /Users/q/.claude/plugins/tmup && npm run build --workspace=mcp-server
```

Expected: No errors.

- [ ] **Step 3: Spot-check all 7 changed files**

Read the following files and confirm the interactive session model is present:

1. `skills/tmup/SKILL.md` — "Interactive Session Model" section before MCP Tools
2. `skills/tmup/REFERENCE.md` — "Interactive Session Rule" heading before tmup_init
3. `mcp-server/src/tools/index.ts` — dispatch says "interactive Codex session", reprompt says "send-keys"
4. `mcp-server/dist/index.js` — contains "session_mode" and "follow_up_via"
5. `tests/mcp/handle-tool-call.test.ts` — dispatch assertion includes `session_mode: 'interactive'`
6. `crossmodel-supervisor.md` — "Pane Interaction Model" section
7. `sdlc-crossmodel/SKILL.md` — "Session Control Model" subsection
8. `commands/tmup.md` — "Session Model" section

- [ ] **Step 4: Verify guard wording consistency**

Grep all changed files for "idle" and confirm every mention uses "idle or queueable" or "idle or explicitly queueable", never just "idle" alone:

```bash
cd /Users/q/.claude/plugins/tmup
grep -n 'idle' skills/tmup/SKILL.md skills/tmup/REFERENCE.md commands/tmup.md
cd /Users/q/.claude/plugins/sdlc-os
grep -n 'idle' agents/crossmodel-supervisor.md skills/sdlc-crossmodel/SKILL.md
```

Expected: No instance of bare "idle" without "or queueable" in the new content.
