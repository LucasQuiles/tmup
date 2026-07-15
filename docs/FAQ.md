[< Back to README](../README.md)

# FAQ

**Q: Do I need both Claude Code and Codex?**

Yes. Claude Code is the lead (orchestrator). Codex CLI workers do the actual coding in tmux panes. They're different products from different companies; the lead-side MCP service owns the SQLite task state and supervises the safe workers through dispatch, harvest, and reprompt. The future is weird and we're living in it.

**Q: How many workers can I run?**

The default grid is 2x4 (8 panes). You can change this in `config/policy.yaml`. Each worker is a Codex CLI process whose context and compaction behavior come from its resolved runtime. More workers means more parallelism and more supervisor work. Native-child admission is pane-local rather than a shared global budget, so configured pane and thread counts can multiply concurrency but do not define a measured safe aggregate. We've run 8 workers reviewing tmup's own codebase simultaneously. They found real bugs. We are still processing this emotionally.

**Q: Which Codex model does a worker use?**

With the default `codex.model: "auto"`, tmup omits `-m` and the installed Codex CLI chooses its default. An explicit pin is direct-dispatch-only and fails closed unless policy enables it and that dispatch includes `--model-validation-receipt`; the request and receipt still do not prove which model was served. Direct dispatch accepts a valid absolute `CODEX_BIN`, then executable `~/.local/bin/codex`, then its fixed controller `PATH`. MCP ignores inherited `CODEX_BIN` and resolves from `~/.local/bin/codex` or the MCP process's original `PATH` before controller filtering.

**Q: What happens if a worker crashes?**

The lead detects stale claims via heartbeat timeouts and can reassign the work. Retriable failures (crash, timeout) auto-retry with exponential backoff. Non-retriable failures (logic errors) escalate to `needs_review` for the lead to handle. No task is silently lost. Unless the SQLite file itself is deleted, in which case all tasks are silently lost, but that's on you.

**Q: Can I use this without tmux?**

No. tmux is the grid. Without it, where would the agents live? In your heart? That's not how computers work.

**Q: Is this production ready?**

Define "production." It has a broad Vitest suite, which is more than some things that are in production. It handles concurrent database access, dead workers, dependency cascades, and retry backoff. We used it to review its own codebase and the workers found real bugs, which is either a testament to its usefulness or a damning indictment of the code they were reviewing. We're not sure which. Should you bet your company on it? No. Should you use it to parallelize a refactoring task on a Saturday? Probably. Maybe. We're not liable.

**Q: Why SQLite and not Redis/Postgres/a real database?**

Because it's one file and it works. We didn't want to run a database server. We didn't want connection strings. We didn't want Docker. We wanted a file that multiple processes could read and write simultaneously without corrupting each other's data. SQLite WAL mode does that. Is it the "right" choice for multi-agent coordination? Probably not. Did we look at alternatives? Briefly. Did we go back to SQLite because it was already working? Yes. We are not above path dependence.

**Q: Why Bash for the scripts?**

Because tmux is a terminal thing, Codex runs in a terminal, and Bash is the language of terminals. We're not going to write a TypeScript wrapper around `tmux send-keys`. We're not going to spawn a Node.js child process to run `tmux list-panes`. We're going to write a Bash script that does exactly what it says, with `set -euo pipefail` at the top, and we're going to move on with our lives.

**Q: What does "content framing" mean?**

Trusted-mode inbox messages are wrapped in `[WORKER MESSAGE from <id>]...[END WORKER MESSAGE]` tags. The safe lane's primary worker-to-lead channel is also framed: `tmup_harvest` and pre-reprompt harvests wrap ANSI-stripped scrollback in `[UNTRUSTED PANE OUTPUT ...]...[END UNTRUSTED PANE OUTPUT]`, neutralize worker-printed marker text, and attach an `untrusted_worker_output` label. Framing helps the lead treat model output as data, but it is not a complete prompt-injection boundary.

**Q: Why is it called tmup?**

**t**mux + tea**m** **up** = **tmup**. It's a team-up. In tmux. Get it? Get it? We're not changing the name. We've already bought the domain. (We haven't actually bought the domain.)

**Q: I found a bug.**

Congratulations. You're now qualified to open a GitHub issue. Or you could use tmup to dispatch 8 agents to fix it. That's the move.

---

## Known limitations

We believe in radical transparency about the things that don't work. Here's what will bite you if you're not careful:

- **Terminal auto-launch is Linux-specific.** The shell scripts avoid the known GNU-only blockers (flock-only locking, GNU date ISO flags, realpath-only canonicalization, and GNU find minute filters) via portable helpers, so the tmux/grid path works on macOS too. GNOME Terminal auto-launch still assumes a Linux desktop; on macOS, attach to the tmux session manually.
- **No hot-reload.** The MCP server loads at session start. Code changes require build + cache sync + session restart. Every time. Yes, it's annoying. No, there's no fix. The MCP protocol doesn't support runtime code swaps.
- **CLI flag parsing is intentionally small.** Unknown flags fail closed instead of changing behavior silently. If a positional message starts with `--`, pass `--` first: `tmup-cli message -- "--not-a-flag"`.
- **Safe Codex workers do not receive shared session state.** They use `workspace-write` with direct shell network disabled, both ambient temp grants excluded, and only one exact mode-0700 protected task temp as an extra `--add-dir`. tmup does not explicitly set `TMUP_DB` or `TMUP_SESSION_DIR` in their core-inherited command environment, and their prompt does not advertise `tmup-cli`. Mediated Codex web search can still be available. This constrains writes but does not provide exhaustive read isolation.
- **Controller artifacts are separate.** Prompts, launchers, and logs are outside working/session/task roots under protected controller state. Prompts/logs are mode 0600, launchers are mode 0700, prompt/launcher hashes and modes are checked, and teardown removes the exact validated controller session root.
- **Sandbox observations are runtime-specific.** Deterministic controller-boundary tests are not a substitute for a live runtime canary. Host- and release-specific canaries remain pending, so do not generalize the configured boundary across versions or hosts.
- **Trusted modes are direct-only escape hatches.** Shared-state Codex requires policy enablement plus `--trusted-shared-state` and its receipt; it restores the session add-dir and `TMUP_DB`/`TMUP_SESSION_DIR`, so peer integrity is advisory. Claude Code requires separate policy enablement plus `--allow-unconfined-claude-code` and its receipt; it uses `bypassPermissions` and is outside the Codex sandbox guarantee. MCP exposes neither mode and strips ambient trust/tier/shell overrides.
- **Safe-pane database messages are records, not delivery.** `tmup_send_message`, pause, and teardown can store controller/audit messages, but safe workers do not poll the database inbox. Use `tmup_reprompt` for delivery, harvest the result, and run `/bin/bash -p scripts/grid-teardown.sh` from the plugin root when stopping a grid. The teardown `force` flag only skips storing shutdown messages.
- **Heartbeat timeout is coarse.** Default stale threshold is 5 minutes. If a worker crashes, the lead won't notice until the next `tmup_status` call after the timeout. Fast recovery requires frequent status polling.
- **One grid per project directory.** The session registry is keyed by canonical project path. If you want two grids for the same project, you'll need to hack the session name.
