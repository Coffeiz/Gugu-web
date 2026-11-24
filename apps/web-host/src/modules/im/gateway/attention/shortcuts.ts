import { decideImShortcut, immediateImCommandReply, parseImControlCommand } from '@gugu/core/im/shortcut'
import type { ImPreflightPorts } from '@gugu/gateway'
import { ImShortcutUnavailable, type createPostgresImShortcut } from './receipts.js'

/** 将纯意图与正式PG目标收据相连；不以当前会话ID重新寻找取消目标。 */
export function createImShortcutControls(options: {
  state: Pick<ReturnType<typeof createPostgresImShortcut>, 'read' | 'cancel'>
  compact?(scope: Parameters<ImPreflightPorts['decideShortcut']>[0], signal: AbortSignal): Promise<string>
  /** 与外层控制器一致，避免 IM 帮助回退到快捷层时漏报已接通命令。 */
  helpCommands?: readonly string[]
  diagnose(code: 'shortcut_read_unavailable' | 'compact_unavailable'): void
}): Pick<ImPreflightPorts, 'decideShortcut' | 'cancel'> {
  if (typeof options.state?.read !== 'function' || typeof options.state.cancel !== 'function' || typeof options.diagnose !== 'function')
    throw new TypeError('IM 快捷控制服务未完整配置')
  return {
    async decideShortcut(scope, text, signal) {
      signal.throwIfAborted()
      const available = options.helpCommands ?? (options.compact ? ['stop', 'status', 'compact', 'help'] : ['stop', 'status', 'help'])
      const immediate = immediateImCommandReply(text, available)
      if (immediate) return { action: 'reply', reply: immediate }
      const command = parseImControlCommand(text)
      if (command?.name === 'compact' && options.compact)
        return { action: 'reply', reply: await options.compact(scope, signal) }
      let state: Awaited<ReturnType<typeof options.state.read>>
      try { state = await options.state.read(scope) }
      catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof ImShortcutUnavailable)) throw error
        // 对齐Python非权威快捷状态读取失败后的正常Run路径；固定诊断不冒称控制成功。
        options.diagnose('shortcut_read_unavailable')
        return command ? { action: 'reply', reply: '当前无法读取任务状态，请稍后重试。' } : { action: 'run' }
      }
      signal.throwIfAborted()
      const decision = decideImShortcut(text, state.state, { currentPlatformUserId: scope.platformUserId,
        activePlatformUserIds: state.initiatorIds, awaiting: state.awaiting,
        helpCommands: available })
      if (decision.action === 'cancel') {
        if (!state.cancelReference) throw new ImShortcutUnavailable()
        return { action: 'cancel', reply: decision.reply, reference: state.cancelReference }
      }
      if (decision.action === 'run') return { action: 'run' }
      if (decision.action === 'reply' || decision.action === 'no_permission') return { action: decision.action, reply: decision.reply }
      throw new ImShortcutUnavailable()
    },
    async cancel(scope, reference, signal) {
      signal.throwIfAborted()
      return options.state.cancel(scope, reference, signal)
    },
  }
}
