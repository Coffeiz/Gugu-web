import { ExecutionError } from './contracts.js'
import type {
  ExecutionBackend,
  ExecutionGrant,
  ExecutionRequest,
  ExecutionResult,
} from './contracts.js'
import { executionPolicy } from './policy.js'
import { MxcExecutor } from './mxc.js'

// 入口由 Node Host 显式加载；portable 契约不会导入本模块或原生 SDK。
export async function mxcDiagnostics() {
  if (process.platform !== 'win32')
    return {
      supported: false,
      methods: [],
      checkAvailable: false,
      reason: '当前平台尚无已接入的原生隔离后端',
    }
  try {
    const sdk = await import('@microsoft/mxc-sdk/v1'),
      support = sdk.getPlatformSupport(),
      facts = sdk.probe()
    const supported =
      support.isSupported &&
      support.availableMethods.includes('processcontainer') &&
      !facts.error &&
      facts.tier === 'base-container' &&
      facts.needsDaclAugmentation === false
    return {
      supported,
      methods: supported ? ['processcontainer'] : [],
      checkAvailable: true,
      reason: supported
        ? '已探测到原生后端；完整 Node/MCP/PTY 工具链仍待验收'
        : '当前环境不能落实严格隔离策略，未修改系统权限',
    }
  } catch {
    return {
      supported: false,
      methods: [],
      checkAvailable: false,
      reason: '原生 SDK 加载或探测失败，严格执行能力已禁用',
    }
  }
}
export async function createMxcExecutor(): Promise<MxcExecutor> {
  if (!(await mxcDiagnostics()).supported)
    throw new ExecutionError('unsupported', '严格 MXC 隔离不可用')
  const sdk = await import('@microsoft/mxc-sdk/v1')
  return new MxcExecutor((request) => sdk.spawn(request, { telemetry: { enabled: false } }))
}
export class Executor {
  private attempted = new Set<string>()
  constructor(private backends: readonly ExecutionBackend[]) {}
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
