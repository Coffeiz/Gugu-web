import { ExecutionError } from '../contracts.js'
import type { MxcDiagnostics } from '../mxc/platform.js'
import { MxcExecutor } from '../mxc/executor.js'

async function diagnostics(): Promise<MxcDiagnostics> {
  try {
    const sdk = await import('@microsoft/mxc-sdk/v1')
    const support = sdk.getPlatformSupport()
    if (support.isSupported && support.availableMethods.includes('seatbelt'))
      return { supported: true, methods: ['seatbelt'], checkAvailable: true }
    return { supported: false, methods: [], checkAvailable: true, reason: '当前环境未提供 MXC Seatbelt' }
  } catch {
    return { supported: false, methods: [], checkAvailable: false, reason: '无法加载 MXC Seatbelt' }
  }
}

export const macosShell = {
  id: 'mxc-seatbelt-offline-v1',
  method: 'seatbelt',
  diagnostics,
  async createExecutor() {
    if (!(await diagnostics()).supported) throw new ExecutionError('unsupported', 'MXC Seatbelt 不可用')
    const sdk = await import('@microsoft/mxc-sdk/v1')
    return new MxcExecutor(request => sdk.spawn({
      ...request, ui: { disable: true, clipboard: 'none', allowInputInjection: false },
    }, { telemetry: { enabled: false } }), 'seatbelt')
  },
  command(command: string) {
    return `/bin/sh -c '${command.replaceAll("'", "'\\''")}'`
  },
}
