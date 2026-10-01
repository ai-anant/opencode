export * as ConfigHooksV1 from "./hooks"

import { Schema } from "effect"

const Hook = Schema.Struct({
  type: Schema.String,
  command: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Seconds before a command hook is canceled. Defaults to 600. Ignored unless type is command.",
  }),
}).annotate({
  description: "A Stop hook handler. Only type command is executed; other types are accepted and ignored.",
})

const Group = Schema.Struct({
  matcher: Schema.optional(Schema.String),
  hooks: Schema.optional(Schema.mutable(Schema.Array(Hook))),
})

export const Info = Schema.Struct({
  Stop: Schema.optional(Schema.mutable(Schema.Array(Group))).annotate({
    description:
      "Commands that run when the top-level agent finishes a turn. Exit 2 or JSON decision:block continues the turn.",
  }),
}).annotate({
  identifier: "Hooks",
  description: "Lifecycle hooks. Stop matches the Claude Code Stop hook contract.",
})

export type Info = Schema.Schema.Type<typeof Info>
