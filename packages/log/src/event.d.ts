interface RunIdentity {
  readonly ownerId: string
  readonly sessionId: string
  readonly runId: string
}

interface RunEvent {
  readonly identity: RunIdentity
  readonly at: number
  readonly level: 'info' | 'warn' | 'error'
  readonly event: string
  readonly round?: number
  readonly attributes?: Readonly<Record<string, string | number | boolean | null>>
}

export interface AgentLog {
  readonly log: { write(event: RunEvent): void }
  diagnose(code: string, failure?: { identity: RunIdentity; phase: string; error: unknown }): void
}

export function createAgentLog(options: {
  regular(line: string): void
  diagnostic(line: string): void
  fingerprint(value: string): string
  now?: () => number
}): AgentLog
