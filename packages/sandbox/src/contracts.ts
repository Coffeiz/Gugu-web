

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
export interface ExecutionService {
  execute(
    request: ExecutionRequest,
    grant: ExecutionGrant,
    signal?: AbortSignal,
  ): Promise<ExecutionResult>
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


/** 只由已认证的 Run 上下文建立，模型参数不能覆盖这些字段。 */
export interface HarnessExecutionScope {
  readonly ownerId: string
  readonly sessionId: string
  readonly runId: string
  readonly roundId: string
  readonly toolCallId: string
}

export interface HarnessExecutor {
  execute(scope: HarnessExecutionScope, request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>
}

export interface HarnessExecutorPorts {
  /** 每次调用重新检查工具权限、资源范围和单次确认，不能缓存上一轮授权。 */
  authorize(scope: HarnessExecutionScope, request: Readonly<ExecutionRequest>, signal?: AbortSignal): Promise<ExecutionGrant>
  executor: ExecutionService
  /** 受限诊断端口；原始异常不得进入事件、公开日志或 Canonical 历史。 */
  diagnose?(error: unknown): void
}
