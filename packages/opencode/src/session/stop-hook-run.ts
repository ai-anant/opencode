import { Shell } from "@opencode-ai/core/shell"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { errorMessage } from "@/util/error"
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  interpretCommandResult,
  interpretPluginOutput,
  mergeStopResults,
  stopHookInput,
  type CommandHook,
  type HookOutput,
  type Interpreted,
  type StopAction,
} from "./stop-hook"

const MAX_OUTPUT_BYTES = 1024 * 1024

export function runCommandHook(input: {
  command: string
  cwd: string
  shell?: string
  stdin: string
  timeoutSeconds?: number
  env?: NodeJS.ProcessEnv
}): Effect.Effect<Interpreted> {
  const timeoutMs = Math.max(1, (input.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000)
  return Effect.callback<Interpreted>((resume) => {
    let settled = false
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let overflow = false
    const shell = Shell.preferred(input.shell)
    const child = spawn(shell, Shell.args(shell, input.command, input.cwd), {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    const finish = (value: Interpreted) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resume(Effect.succeed(value))
    }
    const take = (chunk: Buffer, target: "stdout" | "stderr") => {
      const text = chunk.toString("utf8")
      if (target === "stdout") stdout += text
      else stderr += text
      if (!overflow && stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        overflow = true
        child.kill("SIGKILL")
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => take(chunk, "stdout"))
    child.stderr?.on("data", (chunk: Buffer) => take(chunk, "stderr"))
    child.stdin?.on("error", () => {})
    child.on("error", (err) => {
      finish({
        block: false,
        warning: `Stop hook failed to start (${input.command}): ${err.message}`,
      })
    })
    child.on("close", () => {
      if (overflow) {
        finish({ block: false, warning: `Stop hook output exceeded ${MAX_OUTPUT_BYTES} bytes: ${input.command}` })
        return
      }
      finish(
        interpretCommandResult({
          exitCode: child.exitCode,
          stdout,
          stderr,
          timedOut,
          command: input.command,
        }),
      )
    })
    try {
      child.stdin?.end(input.stdin)
    } catch {
      // The error/close handler reports a failed spawn.
    }

    return Effect.sync(() => {
      settled = true
      clearTimeout(timer)
      child.kill("SIGKILL")
    })
  })
}

export function runStopHooks(input: {
  sessionID: string
  cwd: string
  shell?: string
  commands: CommandHook[]
  stopHookActive: boolean
  continuationCount: number
  cap: number
  lastAssistantMessage?: string
  plugin: (output: HookOutput) => Effect.Effect<HookOutput>
}): Effect.Effect<StopAction> {
  return Effect.gen(function* () {
    const stdin = JSON.stringify(
      stopHookInput({
        sessionID: input.sessionID,
        cwd: input.cwd,
        stopHookActive: input.stopHookActive,
        lastAssistantMessage: input.lastAssistantMessage,
      }),
    )
    const env = {
      ...process.env,
      OPENCODE_PROJECT_DIR: input.cwd,
      // Let scripts ported from Claude Code resolve the project root.
      CLAUDE_PROJECT_DIR: input.cwd,
      OPENCODE_SESSION_ID: input.sessionID,
    }
    const commandResults = yield* Effect.forEach(
      input.commands,
      (hook) =>
        runCommandHook({
          command: hook.command,
          cwd: input.cwd,
          shell: input.shell,
          stdin,
          timeoutSeconds: hook.timeout,
          env,
        }),
      { concurrency: 1 },
    )
    const pluginResult = yield* input.plugin({}).pipe(
      Effect.map((output) => interpretPluginOutput(output)),
      Effect.catch((error) =>
        Effect.succeed<Interpreted>({
          block: false,
          warning: `session.stop plugin failed: ${errorMessage(error)}`,
        }),
      ),
    )
    return mergeStopResults({
      results: [...commandResults, pluginResult],
      continuationCount: input.continuationCount,
      cap: input.cap,
    })
  })
}
