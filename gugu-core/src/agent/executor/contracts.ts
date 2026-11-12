export interface ExecutionRequest {
  id: string
  command: string
  cwd: string
  timeoutMs: number
  destructive: boolean
}
// 仅由可信 Host 建立，不从模型、Renderer 或请求体构造授权。
export interface ExecutionGrant {
  requestId: string
  backend: string
  command: string
  cwd: string
  confirmed: boolean
  readonlyPaths: readonly string[]
  readwritePaths: readonly string[]
  environment: Readonly<Record<string, string>>
  timeoutMs: number
  maxOutputBytes: number
}
export interface ExecutionCapabilities {
  filesystem: boolean
  networkDeny: boolean
  uiDeny: boolean
  timeout: boolean
  cancellation: boolean
}
export interface ExecutionPolicy extends ExecutionGrant {
  requestId: string
}
export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}
export interface ExecutionBackend {
  readonly id: string
  readonly capabilities: ExecutionCapabilities
  execute(policy: ExecutionPolicy, signal?: AbortSignal): Promise<ExecutionResult>
}
export class ExecutionError extends Error {
  constructor(
    readonly code:
      | 'denied'
      | 'cancelled'
      | 'output_limit'
      | 'native_failure'
      | 'unsupported',
    message: string,
  ) {
    super(message)
  }
}
