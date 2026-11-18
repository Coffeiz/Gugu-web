import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { createTerminalCommandService, type TerminalCommandInput, type TerminalCommandPorts } from '@gugu/core/terminals/command'
import { createTerminalEventAppender } from '@gugu/core/terminals/append'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import type { RedisEventPublisher } from '../../adapters/redis-events.js'

/** 终端状态与事件提交后通知；执行端与逐次授权由同一 Host 显式提供。 */
export function createHostTerminalCommandService<DB>(options: {
  db: Kysely<DB>
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>
  authorize(owner: string, terminal: string): Promise<void>
  read(owner: string, terminal: string): Promise<TerminalListItem>
  execute(owner: string, terminal: string, requestId: string, input: TerminalCommandInput, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null; ok: boolean }>
  diagnose(): void
  lease?: TerminalCommandPorts['lease']
}) {
  const append = createTerminalEventAppender(options.db, 'postgres', () => new Date(), true)
  const service = createTerminalCommandService({
    authorize: options.authorize, append, execute: options.execute, nextId: () => randomBytes(16).toString('hex'), diagnose: options.diagnose, lease: options.lease,
    async publish(owner, terminal, event, origin) {
      const { terminalSnapshot, ...payloadEvent } = event
      if (!terminalSnapshot) throw new Error('终端快照不存在')
      await options.publisher.publishResourceChanged({ ownerId: owner, resource: 'terminals', operation: 'append', entityId: terminal, origin,
        payload: { terminal_id: terminal, event: payloadEvent, terminal: terminalSnapshot } })
    },
  })
  return {
    async start(owner: string, terminal: string, input: TerminalCommandInput, origin?: string) {
      // 读取失败必须发生在 running 事件提交前，避免已启动命令却向客户端返回失败。
      await options.read(owner, terminal)
      const result = await service.start(owner, terminal, input, origin)
      const { terminalSnapshot, ...event } = result.event
      if (!terminalSnapshot) throw new Error('终端快照不存在')
      return { terminal: terminalSnapshot, requestId: result.requestId, event }
    },
    cancel: service.cancel,
    close: service.close,
  }
}
