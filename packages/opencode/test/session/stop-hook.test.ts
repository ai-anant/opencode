import { describe, expect, test } from "bun:test"
import {
  assistantText,
  commandHooks,
  continuationCap,
  formatContinuation,
  interpretCommandResult,
  interpretPluginOutput,
  mergeStopResults,
  stopHookInput,
} from "../../src/session/stop-hook"

describe("stop hook decisions", () => {
  test("exit 0 with no JSON allows the stop", () => {
    const result = interpretCommandResult({
      exitCode: 0,
      stdout: "",
      stderr: "ignored",
      timedOut: false,
      command: "ok",
    })
    expect(mergeStopResults({ results: [result], continuationCount: 0, cap: 8 }).action).toBe("stop")
  })

  test("exit 2 blocks using stderr", () => {
    const action = mergeStopResults({
      results: [
        interpretCommandResult({
          exitCode: 2,
          stdout: "",
          stderr: "tests failed",
          timedOut: false,
          command: "npm test",
        }),
      ],
      continuationCount: 0,
      cap: 8,
    })
    expect(action).toMatchObject({ action: "continue", kind: "block", message: "tests failed" })
  })

  test("exit 2 blocks even when JSON tries to allow", () => {
    const result = interpretCommandResult({
      exitCode: 2,
      stdout: JSON.stringify({ decision: "allow" }),
      stderr: "still blocked",
      timedOut: false,
      command: "hook",
    })
    expect(result.block).toBe(true)
    expect(result.reason).toBe("still blocked")
  })

  test("JSON decision block requires a reason", () => {
    const missing = interpretCommandResult({
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block" }),
      stderr: "",
      timedOut: false,
      command: "hook",
    })
    expect(missing.block).toBe(false)
    expect(missing.warning).toContain("requires reason")

    const blocked = interpretCommandResult({
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: "run tests" }),
      stderr: "",
      timedOut: false,
      command: "hook",
    })
    expect(blocked).toMatchObject({ block: true, reason: "run tests" })
  })

  test("additionalContext continues as feedback", () => {
    const action = mergeStopResults({
      results: [
        interpretCommandResult({
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: { hookEventName: "Stop", additionalContext: "run the test suite" },
          }),
          stderr: "",
          timedOut: false,
          command: "hook",
        }),
      ],
      continuationCount: 1,
      cap: 8,
    })
    expect(action).toMatchObject({ action: "continue", kind: "feedback", message: "run the test suite" })
  })

  test("other exit codes and timeouts do not block", () => {
    expect(
      interpretCommandResult({
        exitCode: 1,
        stdout: "not json",
        stderr: "boom",
        timedOut: false,
        command: "hook",
      }).block,
    ).toBe(false)
    expect(
      interpretCommandResult({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: true,
        command: "hook",
      }).warning,
    ).toContain("timed out")
  })

  test("continuation cap overrides another block", () => {
    const action = mergeStopResults({
      results: [interpretPluginOutput({ decision: "block", reason: "again" })],
      continuationCount: 8,
      cap: 8,
    })
    expect(action.action).toBe("stop")
    if (action.action === "stop") expect(action.warnings.join(" ")).toContain("cap (8)")
  })

  test("command config keeps only command hooks", () => {
    expect(
      commandHooks({
        Stop: [
          {
            hooks: [
              { type: "command", command: " bash test.sh ", timeout: 30 },
              { type: "http", command: "https://example.invalid" },
              { type: "command", command: "   " },
            ],
          },
        ],
      }),
    ).toEqual([{ command: "bash test.sh", timeout: 30 }])
  })

  test("stdin payload uses Claude Code field names", () => {
    expect(
      stopHookInput({
        sessionID: "ses_1",
        cwd: "/work",
        stopHookActive: true,
        lastAssistantMessage: "done",
      }),
    ).toMatchObject({
      session_id: "ses_1",
      cwd: "/work",
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "done",
      background_tasks: [],
      session_crons: [],
    })
  })

  test("continuation text and cap env", () => {
    expect(formatContinuation("block", "fix tests")).toContain("fix tests")
    expect(formatContinuation("feedback", "look again")).toContain("<stop-hook-feedback>")
    expect(assistantText([{ type: "reasoning", text: "hidden" }, { type: "text", text: "visible" }])).toBe("visible")
    expect(continuationCap({ OPENCODE_STOP_HOOK_BLOCK_CAP: "3" })).toBe(3)
    expect(continuationCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "4" })).toBe(4)
    expect(continuationCap({ OPENCODE_STOP_HOOK_BLOCK_CAP: "nope" })).toBe(8)
  })
})
