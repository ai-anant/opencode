/**
 * Claude Code-compatible Stop hook decisions.
 *
 * Command hooks receive JSON on stdin and reply with exit codes / JSON.
 * Plugin hooks mutate the same decision fields. Either can keep the agent
 * working; a consecutive-continuation cap stops a hook from looping forever.
 *
 * This module is intentionally free of Effect so the decision rules can be
 * tested without the session runtime.
 */

export const DEFAULT_STOP_HOOK_BLOCK_CAP = 8
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600

export type CommandHook = {
  command: string
  timeout?: number
}

export type HookOutput = {
  decision?: "block"
  reason?: string
  additionalContext?: string
}

export type Interpreted = {
  block: boolean
  reason?: string
  additionalContext?: string
  warning?: string
}

export type StopAction =
  | { action: "stop"; warnings: string[] }
  | { action: "continue"; kind: "block" | "feedback"; message: string; warnings: string[] }

type HookConfig = {
  Stop?: Array<{
    hooks?: Array<{ type?: string; command?: string; timeout?: number }>
  }>
}

export function continuationCap(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCODE_STOP_HOOK_BLOCK_CAP ?? env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
  if (raw == null || raw === "") return DEFAULT_STOP_HOOK_BLOCK_CAP
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STOP_HOOK_BLOCK_CAP
  return Math.floor(n)
}

export function commandHooks(hooks: HookConfig | undefined): CommandHook[] {
  const out: CommandHook[] = []
  for (const group of hooks?.Stop ?? []) {
    for (const hook of group.hooks ?? []) {
      if (hook.type !== "command") continue
      const command = hook.command?.trim()
      if (!command) continue
      const timeout = typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout : undefined
      out.push({ command, ...(timeout ? { timeout } : {}) })
    }
  }
  return out
}

export function assistantText(parts: ReadonlyArray<{ type: string; text?: string }>) {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text || undefined
}

export function stopHookInput(input: {
  sessionID: string
  cwd: string
  stopHookActive: boolean
  lastAssistantMessage?: string
}) {
  return {
    session_id: input.sessionID,
    cwd: input.cwd,
    hook_event_name: "Stop" as const,
    stop_hook_active: input.stopHookActive,
    last_assistant_message: input.lastAssistantMessage ?? "",
    // OpenCode does not yet track Claude Code's background task registry.
    background_tasks: [] as [],
    session_crons: [] as [],
  }
}

export function formatContinuation(kind: "block" | "feedback", message: string) {
  if (kind === "block") {
    return [
      "<stop-hook>",
      "Stop hook blocked completion. Continue working and address this before stopping:",
      "",
      message.trim(),
      "</stop-hook>",
    ].join("\n")
  }
  return ["<stop-hook-feedback>", message.trim(), "</stop-hook-feedback>"].join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function additionalContextOf(parsed: Record<string, unknown>) {
  if (!isRecord(parsed.hookSpecificOutput)) return
  if (parsed.hookSpecificOutput.hookEventName != null && parsed.hookSpecificOutput.hookEventName !== "Stop") return
  const text = parsed.hookSpecificOutput.additionalContext
  if (typeof text !== "string" || !text.trim()) return
  return text
}

export function interpretCommandResult(input: {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  command: string
}): Interpreted {
  if (input.timedOut) {
    return { block: false, warning: `Stop hook timed out: ${input.command}` }
  }

  const stdout = input.stdout.trim()
  let parsed: Record<string, unknown> | undefined
  let parseError: string | undefined
  if (stdout.startsWith("{")) {
    try {
      const value = JSON.parse(stdout)
      if (isRecord(value)) parsed = value
      else parseError = "Stop hook JSON must be an object"
    } catch (err) {
      parseError = err instanceof Error ? err.message : "invalid JSON"
    }
  }

  const decision = parsed?.decision === "block" ? "block" : undefined
  const reason = typeof parsed?.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined
  const additionalContext = parsed ? additionalContextOf(parsed) : undefined

  // Exit 2 always blocks. JSON cannot override it.
  if (input.exitCode === 2) {
    const message =
      decision === "block" && reason ? reason : input.stderr.trim() || reason || "Stop hook blocked completion"
    return { block: true, reason: message, additionalContext }
  }

  if (parseError) {
    return { block: false, warning: `Stop hook JSON error (${input.command}): ${parseError}` }
  }

  if (decision === "block") {
    if (!reason) {
      return { block: false, warning: `Stop hook decision "block" requires reason (${input.command})` }
    }
    return { block: true, reason, additionalContext }
  }

  if (input.exitCode != null && input.exitCode !== 0) {
    return {
      block: false,
      additionalContext,
      warning: `Stop hook exited ${input.exitCode} (${input.command})`,
    }
  }

  return { block: false, additionalContext }
}

export function interpretPluginOutput(output: HookOutput, label = "session.stop"): Interpreted {
  const additionalContext = output.additionalContext?.trim() || undefined
  if (output.decision === "block") {
    const reason = output.reason?.trim()
    if (!reason) return { block: false, warning: `${label} decision "block" requires reason` }
    return { block: true, reason, additionalContext }
  }
  return { block: false, additionalContext }
}

export function mergeStopResults(input: {
  results: Interpreted[]
  continuationCount: number
  cap: number
}): StopAction {
  const warnings = input.results.flatMap((result) => (result.warning ? [result.warning] : []))
  const blocks = input.results.filter((result): result is Interpreted & { reason: string } =>
    Boolean(result.block && result.reason),
  )
  const feedback = input.results
    .map((result) => result.additionalContext?.trim())
    .filter((text): text is string => Boolean(text))
  const wantsContinue = blocks.length > 0 || feedback.length > 0
  if (wantsContinue && input.continuationCount >= input.cap) {
    warnings.push(`Stop hook continuation cap (${input.cap}) reached; allowing stop`)
    return { action: "stop", warnings }
  }
  if (blocks.length > 0) {
    const extra = feedback.filter((text) => !blocks.some((block) => block.reason.includes(text)))
    return {
      action: "continue",
      kind: "block",
      message: [...blocks.map((block) => block.reason), ...extra].join("\n\n"),
      warnings,
    }
  }
  if (feedback.length > 0) {
    return { action: "continue", kind: "feedback", message: feedback.join("\n\n"), warnings }
  }
  return { action: "stop", warnings }
}
