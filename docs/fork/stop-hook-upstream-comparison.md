# Stop hook: upstream PRs vs this fork

Date: 2026-10-01
Fork branch: `ai-anant/opencode` `feat/stop-hook`
Our implementation commit: `b53dd930bffde053d392dd73d71b433e6f3c870f`
Upstream: `anomalyco/opencode` `dev`

This note records what upstream already tried, why those changes are not in `dev`, and how they differ from the Stop hook on this branch. It is fork documentation, not an upstream design doc.

## What "picked" means here

None of the Stop-hook implementations below are in `dev`. That is not the same as "maintainers rejected the idea."

What the record actually shows:

- The two serious open PRs have green guideline checks, no merge conflicts (`mergeable: true`), and **zero review comments**. `mergeable_state: blocked` on both is branch protection waiting for a review, not a failing test.
- The checks that ran are the lightweight bots (`check-compliance`, `check-duplicates`, `check-standards`, `add-contributor-label`). They are not a typecheck or session-test gate.
- Older PRs were closed by **automated cleanup**, not by a reviewer saying the design was wrong.
- The one maintainer conversation that does exist (November 2025, PR #3915) told the author to use `session.idle` instead. Later issues argue that workaround is the wrong lifecycle point. No maintainer has come back and picked a replacement.
- Two open PRs implement the same issue and their authors have not been asked to converge. The newer author already offered to close theirs in favor of the older one.

OpenCode's own cleanup comment on the closed PR says the project gets more PRs than maintainers review, and that old, low-reaction PRs are closed so review time goes to active ones. Low reaction count is a queue policy, not a technical verdict.

## The problem everyone is circling

`session.idle` fires **after** the agent loop has already broken. A plugin can call `client.session.chat` to re-prompt, but:

1. In `opencode run`, process teardown races that re-prompt (called out as #15267 from issue #16626).
2. The follow-up shows up as a new visible user turn, which is the wrong shape for "you are not done, keep working."

Claude Code's Stop hook runs **before** the turn ends. Exit code 2, or JSON `decision: "block"` plus `reason`, feeds that text back and the same turn continues. `stop_hook_active` and an 8-continuation cap stop a hook from looping forever. `additionalContext` continues as feedback rather than a hook error. User interrupt and API errors do not fire Stop.

Issue #16626 asks for the in-loop plugin form of that. Issue #12472 asks for the shell-script form, including reading `~/.claude/settings.json`, plus PreToolUse and PostToolUse. Those are related and not the same feature.

## Upstream attempts

### Still open

#### #44712 — `session.stopping` for loop continuation

- Author: orenbaldinger
- Opened: 2026-08-24. Still open. Last update the same day.
- Closes #16626.
- Reactions: 3 thumbs-up, 1 heart. One bot comment. No human review.
- https://github.com/anomalyco/opencode/pull/44712

Plugin hook only. No shell commands.

```ts
"session.stopping"?: (
  input: { sessionID: string },
  output: { stop: boolean; message?: string },
) => Promise<void>
```

Behavior that is actually in the diff:

- Fires at the natural loop exit (the `exiting loop` site), not on the `result === "stop"` branch. That branch is provider error, tool error, or a blocked permission, and the PR explicitly refuses to hook it.
- Default is fail-closed: `stop: true`. Continuation requires `stop: false` **and** a non-empty message.
- Listeners run in order. `stop: true` is sticky. A later plugin cannot override an earlier veto.
- A throwing listener fails the whole decision closed (`stop: true`, message cleared) but does not skip the remaining listeners before that collapse.
- Core cap is 3 continuations per session, stored in a process-local `Map`. Hitting the cap does **not** reset the counter, so another `prompt.loop` on the same session cannot refill the budget. A clean stop does reset it. The map is deleted on `session.deleted`.
- An in-flight flag skips a concurrent continuation for the same session.
- Continuation is persisted with `createUserMessage({ parts: [{ type: "text", text }] })`. The patch does **not** set `synthetic: true`.
- Tests are the strongest in this set: listener order, error isolation, and an exit matrix (compaction, provider/tool errors, nested sessions, concurrent callers). The PR body claims `bun turbo typecheck` was clean. That was not re-run for this note.

#### #47300 — `experimental.session.stopping`

- Author: YASoftwareDev
- Opened: 2026-09-04. Still open. Last update the same day.
- Also closes #16626. The author says this is the smaller variant of #44712 and offers to close it if maintainers prefer #44712.
- Reactions: 1 thumbs-up. No human review.
- https://github.com/anomalyco/opencode/pull/47300

```ts
"experimental.session.stopping"?: (
  input: { sessionID: string; messageID: string },
  output: { continue: boolean; message?: string },
) => Promise<void>
```

Behavior in the diff:

- Same fire site as #44712: natural exit, after the orphan-tool warning, before `break`.
- Skips the hook when the assistant message has an error, and when `step` has reached the agent's `steps` limit. A plugin cannot extend a run past that limit. Past that, a plugin that always continues runs until the limit. There is no separate re-entry cap.
- Continues only when `continue` is true **and** `message` is set. `continue` without a message is a no-op.
- Injects a user message with `synthetic: true`, which is what #16626 asked for (not a visible re-prompt).
- Does not special-case subagents, plugin throws, or multiple listeners. It uses the normal `plugin.trigger`, so one throw fails the effect.
- Three tests against the fake LLM: continue once, continue without a message, no plugin. The author reports `bun typecheck` and the prompt tests passing on 2026-09-04.

This is the closest upstream design to a minimal, correct plugin hook. It does not run shell scripts.

### Closed without a technical review

#### #16598 — first `session.stopping`

- Author: yehudacohen
- Opened 2026-03-08. Closed 2026-05-15 by rekram1-node's **Automated PR Cleanup**.
- Criteria stated in the close comment: older than one month, fewer than 2 positive reactions. This PR had zero.
- https://github.com/anomalyco/opencode/pull/16598

Same idea as #44712, written against the pre-Effect `prompt.ts` (`await Plugin.trigger`, `log.info`). No re-entry cap, on purpose: the author said the right guard is plugin-specific and a core cap would reject valid plugins. A third party (nbilbeny) rebased it onto the Effect loop on 2026-04-29 and offered the branch to maintainers. The author said maintainers could take that rebase. Nobody did. The cleanup then closed the original PR. The rebase was not opened as its own PR in this search.

This was not closed because the hook was wrong. It aged out of the review queue.

#### #47216 — `session.start`, `session.end`, and `stop`

- Author: gmhelmold
- Opened 2026-09-04 04:32 UTC. Closed 2026-09-04 04:42 UTC by the template bot: description did not match the PR template, 2 hour limit. Ten minutes of life. No review.
- https://github.com/anomalyco/opencode/pull/47216

The Stop half of this PR is at the wrong site. It hooks `if (result === "stop")`, which in current `prompt.ts` is the blocked-or-error return from the processor, not a normal finish. #47300 calls this out. The hook also sets `reason: "completed"` unconditionally on that branch, then only honors `output.continue` when reason is `"completed"`. So it both fires on the wrong exit and labels that exit as a clean completion.

It does not inject a message. Continuing returns `"continue"` and the loop reprocesses the same user message. The model is not told why it should keep going.

`session.start` / `session.end` are a different feature. Wiring them required a `Proxy` around `Plugin.node` because `session.ts` and `plugin/index.ts` import each other. That is a real constraint, and a reason not to hang session-create hooks off this PR even if someone reopens it.

The author listed shell hooks and config matchers as follow-ups, not as part of the PR.

#### #11525 — all 12 Claude Code hooks

- Author: drrozen-med
- Opened 2026-01-31. Closed 2026-04-11 by the 60-day stale bot. No maintainer review. One community "looks awesome" comment.
- https://github.com/anomalyco/opencode/pull/11525

This is the only upstream PR that adds an `opencode.json` `hooks` object and spawns scripts. It is also the one that least implements Stop.

- Written against the old stack: Zod `Config` namespace, `await`, `Bus.publish`, `bun` spawn. Current `dev` is Effect, `ConfigV1` schemas, and `plugin.trigger`. The patch does not apply.
- The service comment says the bridge is **non-blocking**. `prompt.ts` only publishes bus events. Nothing reads an exit code and nothing injects a continuation. A Stop script cannot keep the agent working.
- Stop is published from `processor.ts` on the blocked and error returns, not from the natural loop exit. Same miss as #47216.
- Config shape is `{ name, path, enabled, timeout }` with a 5000 ms default, not Claude Code's `{ type: "command", command, timeout }` and not stdin JSON plus exit 2. PascalCase event names are the only real compatibility.
- It does not read `~/.claude/settings.json`.
- The PR body pastes the template's own warning about large AI-generated descriptions. Combined with a stale architecture, that is a plausible reason it never got a human review. It is not evidence the feature was declined.

#### #3915 — `agent.complete`

- Author: d33tah
- Opened and closed the same day, 2025-11-04, after a real maintainer thread.
- https://github.com/anomalyco/opencode/pull/3915

rekram1-node asked what this did that `session.idle` did not. The author described Claude's Stop hook: the agent says it made progress and stops; a hook should say it is not done. The maintainer said that can be done from `session.idle` and linked an example. The author agreed to try that and the PR was closed.

That answer was reasonable in November 2025 if the only need was "run something when the turn ends." It does not cover the later, more precise complaint in #16626: idle is too late for `opencode run`, and a chat re-prompt is the wrong message shape. Treat #3915 as outdated guidance, not as a standing rejection of an in-loop hook.

### Issues, not implementations

- **#16626** (open, 2026-03-08, 8 comments). The plugin-hook request. No maintainer reply. Commenters want typecheck-before-stop, CI results in the same turn, and a claims gate. One comment asks for a review and does not get one.
- **#12472** (open, 19 comments). Native Claude Code hooks: read `~/.claude/settings.json`, map PreToolUse / PostToolUse / Stop, honor exit 2. Use cases are shared-repo guardrails, secret redaction, lint-on-edit, token-saving command wrappers. No maintainer reply in the comments pulled for this note. Community consensus in the thread is "do `session.stopping` first, then the tool hooks."
- **#33054** and **#39275**. Closed RFCs for a broader hook router. Not implementations. Not reviewed as designs in the comments pulled here.

## How this branch differs

This branch adds both halves that upstream split apart:

1. A plugin hook, `session.stop`, on the natural loop exit.
2. Config command hooks under `hooks.Stop` that speak the Claude Code Stop protocol: JSON on stdin, exit 2, `decision: "block"` plus `reason`, `additionalContext`, `stop_hook_active`, and a continuation cap.

It does not read `~/.claude/settings.json`. It does not implement PreToolUse or PostToolUse. `background_tasks` and `session_crons` are always empty. Subagent sessions are skipped, and there is no SubagentStop. The unfinished v2 `SessionRunner` is not wired; the CLI still enters through `SessionPrompt.loop`.

| Question | #44712 | #47300 | #47216 | #11525 | This branch |
| --- | --- | --- | --- | --- | --- |
| In `dev`? | No, open, unreviewed | No, open, unreviewed | Closed in 10 minutes | Closed stale | Fork only |
| Fires on natural finish | Yes | Yes | No (`result === "stop"`) | No (blocked/error publish) | Yes |
| Fires on error / interrupt | No | No | Tries to, and mislabels it completed | Publishes, does not decide | No |
| Can a shell script block the stop? | No | No | No | No (background, exit code ignored) | Yes |
| Claude Code stdin / exit 2 / JSON | No | No | No | No | Yes |
| Plugin API | `stop` + `message`, default stop | `continue` + `message` | `continue`, no message | None for the decision | `decision` / `reason` / `additionalContext` |
| Continuation text | `createUserMessage`, not marked synthetic in the patch | Synthetic text part | None; same user turn is retried | None | Synthetic text part, wrapped so the model can see it is a hook |
| Cap | 3 per session, stays exhausted | Agent `steps` only | None | None | 8 per `runLoop`, Claude Code's default, env override |
| Plugin error | Fail closed, other listeners still run, then collapse | `plugin.trigger` error fails the effect | Logged, then the unset `continue` wins | N/A | Fail open: the turn is allowed to stop |
| Several plugins | Sticky veto: one `stop: true` beats later continues | Last writer via shared output, no special merge | Last writer | N/A | Any block continues the agent; reasons are joined |
| Subagents | Hook runs if that session hits the exit | Same | Same | Separate event, no decision | Skipped (`parentID`) |
| Respects `agent.steps` | No | Yes | No | No | No |
| Tests against the session loop | Yes, including an exit matrix | Yes, three fake-LLM cases | Trigger tests; Stop site is wrong | None in the PR | Decision-parser tests plus a spawn check of exit 2. The `prompt.ts` wiring is not covered by a loop test |

## Where upstream is better

**#47300 is the better plugin-only patch if the goal is the smallest change maintainers can review.**

- It fires at the right place.
- It will not continue without a message, so a plugin cannot spin the loop by setting a boolean alone.
- It will not run past `agent.steps`. This branch does not check that. A Stop script that always exits 2 can burn steps until the cap of 8 even when the agent was configured to stop sooner. That is a real hole. #47300 closes it. We should take that guard if this branch is revised.
- The continuation is synthetic, which matches #16626. #44712's `createUserMessage` call does not set `synthetic`, so the follow-up can show up as a normal user turn. That is the UX #16626 was trying to avoid.
- Its tests actually drive `SessionPrompt` and a fake model. Ours do not. A bug in the `prompt.ts` insert (wrong parent, missing part, loop not seeing the new user message) would not be caught by `stop-hook.test.ts`.

**#44712 is the better plugin patch if the goal is not trusting plugins.**

- Fail-closed is the right default for a gate. This branch fails open: a throwing `session.stop` plugin is logged and the agent is allowed to stop. For a "do not stop until tests pass" plugin, fail-open means a bug in the plugin silently skips the gate. #44712 will not do that.
- Listener errors are isolated. Our `runStopHooks` wraps the entire `plugin.trigger` call. One throw drops every plugin decision for that stop, because `Plugin.trigger` does not catch per listener.
- The sticky veto is better when plugins are policies that must be able to force a stop. It is worse when plugins are Claude Code Stop hooks, where any hook must be able to force a continue. See below.
- The exit-matrix tests cover compaction, errors, nested sessions, and concurrent loops. We did not.
- The cap of 3 is cheaper when a plugin is wrong. Eight model turns is a lot of spend. Claude Code uses 8 because that is enough to fix a test suite. #44712 is safer. Ours matches the tool people are porting from. Both are choices. #44712's extra behavior — leaving the counter exhausted so a later `prompt.loop` on the same session still cannot continue — is harsher than Claude Code and harsher than this branch. A new user message should get a fresh cap. #44712 does not give it one until a clean stop resets the map.

**#11525 is broader and worse at Stop.**

Covering twelve events looks closer to #12472. It does not implement the only part that makes Stop different from `session.idle`: a decision that keeps the loop alive. It also targets a codebase shape that is gone. Rebasing it would be a rewrite. Do not treat it as a head start.

**#47216 should not be revived for Stop.** Wrong branch, no reason string, mislabeled `reason`, and a circular-import proxy that the other PRs avoid by not touching `session.ts`. The start/end hooks might be worth a separate, smaller PR. They are not this feature.

## Where this branch is better

**It is the only one that does the thing #12472 asks of Stop.**

The open PRs cannot run an existing Claude Code `stop.sh`. Those scripts read JSON on stdin and exit 2. They are not OpenCode plugins. #11525 spawns scripts but ignores the exit code and uses a different config shape, so those scripts still do not work.

This branch:

- Accepts `hooks.Stop[].hooks[]` with `type: "command"` and `command`, which is the Claude Code settings shape. Extra fields are stripped rather than failing config decode. `http` / `prompt` / `agent` types are accepted and ignored instead of rejecting the whole file.
- Writes `session_id`, `cwd`, `hook_event_name`, `stop_hook_active`, `last_assistant_message` to stdin.
- Treats exit 2 as a block even if stdout JSON says allow. That matches current Claude Code: exit 2 cannot be overridden.
- Requires `reason` when `decision` is `"block"`. A block without a reason does not continue. Same guard as #47300's "no message, no continue," in the field names scripts already use.
- Honors `hookSpecificOutput.additionalContext` as a continue that is not framed as a hook error.
- Sets `OPENCODE_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` so a copied script can find the project.
- Caps consecutive continuations at 8, overridable with `OPENCODE_STOP_HOOK_BLOCK_CAP` or `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. The counter lives inside `runLoop`, so the next user prompt starts clean. That matches Claude Code's consecutive-continuation cap better than #44712's session-lifetime budget.
- Fires at the natural exit, skips assistant errors, and skips subagent sessions. Stop in Claude Code is the main agent. SubagentStop is a separate event. The open PRs would also fire inside a task-tool subagent, which can multiply a "run the tests" hook by every child session. Skipping them is closer to Claude Code Stop. It is also a gap: we did not add SubagentStop.

**Any-block-continues is the right merge for this feature.** #44712's sticky veto is a policy engine. Claude Code Stop is not. If one script says the tests failed, the agent must continue even if another script is silent. Joining reasons is what you want when two checks fail. Sticky veto would let a no-op or a buggy `stop: true` default suppress a real failure. #44712 defaults `stop: true`, so a plugin that forgets to set the field vetoes everyone else. That is safe for "do nothing unless sure" and wrong for "any guard can keep the agent working."

## Where this branch is worse, in one list

- No session-loop test. #47300 and #44712 have them. This is the biggest gap.
- No `agent.steps` ceiling. #47300 has it. A command hook can outlive the agent's own step limit, up to the cap of 8.
- Plugin failures fail open, and one throw drops the rest of the plugin chain. #44712 is stricter and more isolated.
- Does not read `~/.claude/settings.json`. Users must copy the Stop block into `opencode.json`. #12472 asked for the automatic read. None of the code PRs do it either.
- No PreToolUse / PostToolUse. Most of the #12472 comments are about those, not Stop.
- `background_tasks` and `session_crons` are always `[]`. A script that refuses to block while background work is in flight will not see that work.
- Command hooks are synchronous. The default timeout is 600 seconds, matching Claude Code, and a hung script holds the turn that long. #11525's 5 second timeout did not have this problem because it never blocked the loop. Our timeout is the cost of a real decision.
- SubagentStop is missing. Skipping subagents avoids accidental recursion. It also means a quality gate does not apply to task-tool children.
- v2 `SessionRunner` is unwired. That path is not what `SessionPrompt.loop` callers use today. It will matter when it becomes the live loop.
- Docs are English only.

## Why they are still open, stated plainly

There is no review comment that says "we do not want a stop hook." The open PRs are blocked on a required review that has not happened.

Contributing factors, from the PRs and the cleanup text, not from guessing at private triage:

1. Two open implementations of #16626, and the newer author already deferred to the older one. A reviewer has to choose. Nobody has.
2. The cleanup bot removes old, low-reaction PRs. #16598 died that way after a usable rebase was offered and not taken.
3. Template and stale bots close PRs that do not match process, including ones with a real (if flawed) design. #47216 and #11525 died that way.
4. The November 2025 maintainer reply still says `session.idle` is enough. The March 2026 issue explains why it is not. Those two threads were never joined by a maintainer.
5. #12472 is a larger product question (import Claude settings, tool hooks, Stop). The plugin-only PRs do not answer it. A full hook system PR answered a stale version of the codebase and did not implement the Stop decision. Reviewers can look at that spread and wait.
6. Visible CI on the open PRs is guideline lint, not the session suite. Even a reviewer who wanted to merge would still be trusting the author's test log.

None of that makes #44712 or #47300 bad. It means the feature is unreviewed, duplicated, and split between "plugin gate" and "Claude Code scripts," which is exactly the split this fork tried to close for Stop only.

## What to take from them if this branch is revised

In order:

1. Add #47300's `agent.steps` guard before running Stop hooks.
2. Add a `SessionPrompt` test of the kind #47300 has: one continue, one empty block, one clean stop. Add #44712's "error and compaction do not fire the hook" cases.
3. Isolate plugin listener failures the way #44712 does, but do not adopt sticky `stop: true`. For this feature a listener error should be logged and skipped, and a real `decision: "block"` from another listener should still continue.
4. Keep the shell protocol. Do not replace it with #11525's `{name, path}` schema or its fire-and-forget bus.
5. Do not move the trigger to `result === "stop"`. #47216 and #11525 both did, and both missed normal completion.
6. Leave `~/.claude/settings.json` and PreToolUse for a separate change. That is #12472, not this hook.

## Sources

Pulled 2026-10-01 from the GitHub API. SHAs of the upstream PR heads were not re-cloned; the comparisons use the PR file patches and bodies as GitHub returned them.

- https://github.com/anomalyco/opencode/pull/44712
- https://github.com/anomalyco/opencode/pull/47300
- https://github.com/anomalyco/opencode/pull/16598
- https://github.com/anomalyco/opencode/pull/47216
- https://github.com/anomalyco/opencode/pull/11525
- https://github.com/anomalyco/opencode/pull/3915
- https://github.com/anomalyco/opencode/issues/16626
- https://github.com/anomalyco/opencode/issues/12472
- https://github.com/anomalyco/opencode/issues/33054
- https://github.com/anomalyco/opencode/issues/39275
