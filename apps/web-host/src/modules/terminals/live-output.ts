import type { RedisEventPublisher } from '../../adapters/cache/redis-events.js'

/** 临时输出只经 owner 的实时频道发送；持久化终态由命令用例另行提交。 */
export function createTerminalLiveOutput(publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>, now = () => new Date()) {
  return async (owner: string, terminal: string, requestId: string, command: string, stream: 'stdout' | 'stderr', text: string) => {
    await publisher.publishResourceChanged({ ownerId: owner, resource: 'terminals', operation: 'append', entityId: terminal,
      payload: { terminal_id: terminal, event: { sequence: 0, type: 'output', source: 'user', runId: requestId, command,
        stdout: stream === 'stdout' ? text : '', stderr: stream === 'stderr' ? text : '', exitCode: null, occurredAt: now().toISOString() } } })
  }
}
