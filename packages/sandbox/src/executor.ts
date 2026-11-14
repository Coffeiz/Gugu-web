import type { HarnessExecutor, HarnessExecutorPorts } from './contracts.js'

import type {
  ExecutionBackend,
  ExecutionGrant,
  ExecutionRequest,
  ExecutionResult,
  ExecutionService,
} from './contracts.js'
import { ExecutionError } from './contracts.js'
import { executionPolicy } from './policy.js'

/** 共用执行协调器不装载平台后端；真实后端由可信 Host 显式传入。 */
export class Executor implements ExecutionService {
  private attempted = new Set<string>()
  constructor(private backends: readonly ExecutionBackend[]) { }
  async execute(
    request: ExecutionRequest,
    grant: ExecutionGrant,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const backend = this.backends.find((item) => item.id === grant.backend)
    if (!backend) throw new ExecutionError('unsupported', 'Host 未装配已授权的执行后端')
    const policy = executionPolicy(request, grant, backend.capabilities)
    if (this.attempted.has(request.id))
      throw new ExecutionError('denied', '执行结果可能已有副作用，禁止自动重放')
    if (signal?.aborted) throw new ExecutionError('cancelled', '执行已取消')
    this.attempted.add(request.id)
    return backend.execute(policy, signal)
  }
}


export const messages: Record<ExecutionError['code'], string> = {
  denied: '执行授权被拒绝',
  cancelled: '执行已取消',
  output_limit: '执行输出超过限制',
  native_failure: '执行后端失败，执行结果可能未知',
  unsupported: '执行后端无法落实所需隔离策略',
}

/** Harness 和工具仅持有此能力，实际执行始终经过现有 Executor policy。 */
export function createHarnessExecutor(ports: HarnessExecutorPorts): HarnessExecutor {
  return {
    async execute(scope, request, signal) {
      const boundScope = Object.freeze({ ...scope })
      const boundRequest = Object.freeze({ ...request })
      if ([boundScope.ownerId, boundScope.sessionId, boundScope.runId,
      boundScope.roundId, boundScope.toolCallId].some((value) => typeof value !== 'string' || !value))
        throw new ExecutionError('denied', messages.denied)
      if (signal?.aborted)
        throw new ExecutionError('cancelled', messages.cancelled)
      try {
        const grant = await ports.authorize(boundScope, boundRequest, signal)
        if (signal?.aborted)
          throw new ExecutionError('cancelled', messages.cancelled)
        // 不在异常时更换后端或自动重试，避免重复执行已生效的修改。
        return await ports.executor.execute(boundRequest, grant, signal)
      }
      catch (error) {
        try {
          ports.diagnose?.(error)
        }
        catch { /* 诊断失败不改变执行终态。 */ }
        const code = error instanceof ExecutionError ? error.code : 'native_failure'
        throw new ExecutionError(code, messages[code])
      }
    },
  }
}
