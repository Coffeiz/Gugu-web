import { ExecutionError } from './contracts.js'
import { MxcExecutor } from './mxc.js'
export { Executor } from './executor.js'

export interface MxcSupportSnapshot {
  isSupported: boolean
  availableMethods: readonly string[]
  unavailableReasons?: Partial<Record<string, string>>
}

export interface MxcWindowsProbeSnapshot {
  error?: string
  tier?: string
  needsDaclAugmentation?: boolean
}

export interface MxcPlatformDecision {
  supported: boolean
  methods: string[]
  reason?: string
}

/** Linux Web/NAS 固定选 Bubblewrap，不能让 SDK 在可用后端间降级选择。 */
export function mxcContainmentForPlatform(platform: NodeJS.Platform): 'process' | 'bubblewrap' | null {
  if (platform === 'win32') return 'process'
  if (platform === 'linux') return 'bubblewrap'
  return null
}

/** 只报告能够兑现本产品执行边界的后端；Windows 保留既有 ProcessContainer 条件。 */
export function decideMxcPlatformSupport(
  platform: NodeJS.Platform,
  support: MxcSupportSnapshot,
  probe?: MxcWindowsProbeSnapshot,
): MxcPlatformDecision {
  if (platform === 'linux') {
    const available = support.isSupported && support.availableMethods.includes('bubblewrap')
    return available
      ? { supported: true, methods: ['bubblewrap'] }
      : { supported: false, methods: [], reason: support.unavailableReasons?.bubblewrap ?? 'Linux Web Host 需要可用的 MXC Bubblewrap 后端' }
  }
  if (platform === 'win32') {
    const available = support.isSupported && support.availableMethods.includes('processcontainer')
      && !probe?.error && probe?.tier === 'base-container' && probe.needsDaclAugmentation === false
    return available
      ? { supported: true, methods: ['processcontainer'] }
      : { supported: false, methods: [], reason: '当前环境不能落实严格隔离策略，未修改系统权限' }
  }
  return { supported: false, methods: [], reason: '当前平台尚无已接入的原生隔离后端' }
}

// 入口由 Node Host 显式加载；portable 契约不会导入本模块或原生 SDK。
export async function mxcDiagnostics() {
  try {
    const sdk = await import('@microsoft/mxc-sdk/v1')
    if (mxcContainmentForPlatform(process.platform) === null) {
      return { supported: false, methods: [], checkAvailable: false, reason: '当前平台尚无已接入的原生隔离后端' }
    }
    const support = sdk.getPlatformSupport()
    const facts = process.platform === 'win32' ? sdk.probe() : undefined
    const decision = decideMxcPlatformSupport(process.platform, support, facts)
    return {
      ...decision,
      checkAvailable: true,
      ...(decision.supported ? { reason: process.platform === 'linux'
        ? '已探测到 MXC Bubblewrap；多用户执行策略仍须经 Host 实际授权'
        : '已探测到 MXC ProcessContainer；完整 Node/MCP/PTY 工具链仍待验收' } : {}),
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
  const containment = mxcContainmentForPlatform(process.platform)
  if (!containment) throw new ExecutionError('unsupported', '当前平台尚无已接入的原生隔离后端')
  return new MxcExecutor((request) => sdk.spawn(request, { telemetry: { enabled: false } }), containment)
}
