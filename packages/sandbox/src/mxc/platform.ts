import { ExecutionError } from '../contracts.js'
import { MxcExecutor } from './executor.js'
export { Executor } from '../executor.js'

export interface MxcSupportSnapshot {
  isSupported: boolean
  availableMethods: readonly string[]
  unavailableReasons?: Partial<Record<string, string>>
  bubblewrapNetwork?: { proxyEnforcement: 'supported' | 'unsupported'; warnings?: readonly string[] }
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

export interface MxcDiagnostics extends MxcPlatformDecision {
  checkAvailable: boolean
  proxyEnforcement?: boolean
  proxyEnforcementReason?: string
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
export async function mxcDiagnostics(): Promise<MxcDiagnostics> {
  try {
    const sdk = await import('@microsoft/mxc-sdk/v1')
    if (mxcContainmentForPlatform(process.platform) === null) {
      return { supported: false, methods: [], checkAvailable: false, reason: '当前平台尚无已接入的原生隔离后端' }
    }
    const support = sdk.getPlatformSupport()
    const facts = process.platform === 'win32' ? sdk.probe() : undefined
    const decision = decideMxcPlatformSupport(process.platform, support, facts)
    const proxyEnforcement = process.platform === 'linux' && support.bubblewrapNetwork?.proxyEnforcement === 'supported'
    return {
      ...decision,
      proxyEnforcement,
      ...(process.platform === 'linux' && !proxyEnforcement
        ? { proxyEnforcementReason: support.bubblewrapNetwork?.warnings?.join('；') || 'MXC Bubblewrap 代理专用出站未就绪' }
        : {}),
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
export async function createMxcExecutor(networkProxy?: string): Promise<MxcExecutor> {
  const diagnostics = await mxcDiagnostics()
  if (!diagnostics.supported)
    throw new ExecutionError('unsupported', '严格 MXC 隔离不可用')
  if (networkProxy && !diagnostics.proxyEnforcement)
    throw new ExecutionError('unsupported', diagnostics.proxyEnforcementReason ?? 'MXC 代理专用出站不可用')
  const sdk = await import('@microsoft/mxc-sdk/v1')
  const containment = mxcContainmentForPlatform(process.platform)
  if (!containment) throw new ExecutionError('unsupported', '当前平台尚无已接入的原生隔离后端')
  return new MxcExecutor((request) => sdk.spawn(request, { telemetry: { enabled: false } }), containment, networkProxy)
}

/**
 * 启动需要双向标准流的长驻工具进程。目录和命令由 Host 在授权后提供；
 * MCP stdio 没有网络能力，且只读写对应用户的默认工作区。
 */
export async function createMxcStdioProcess(input: {
  command: string
  cwd: string
  workspaceRoot: string
}): Promise<import('@microsoft/mxc-sdk/v1').MxcProcess> {
  const diagnostics = await mxcDiagnostics()
  if (!diagnostics.supported || process.platform !== 'linux')
    throw new ExecutionError('unsupported', 'MCP stdio 需要可用的 Linux MXC Bubblewrap 隔离')
  const sdk = await import('@microsoft/mxc-sdk/v1')
  return sdk.spawn({
    command: input.command,
    workingDirectory: input.cwd,
    containment: { type: 'bubblewrap' },
    filesystem: { readwritePaths: [input.workspaceRoot] },
    network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } },
    ui: { disable: true, clipboard: 'none', allowInputInjection: false },
    environment: {},
    inheritDefaultEnvironment: false,
  }, { telemetry: { enabled: false } })
}
