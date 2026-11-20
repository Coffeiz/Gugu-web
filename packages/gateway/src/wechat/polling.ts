import { setTimeout as delay } from 'node:timers/promises'
import { parseWechatMessage, type WechatInboundPayload, type WechatMediaRequirement } from '@gugu/core/im/wechat-message'
import type { GatewayConnection } from '../index.js'
import type { createILinkClient } from './client.js'
import { createWechatTypingTicketCache } from './typing.js'

export interface WechatPollingOptions {
  botId: string
  ownerId: string
  api: Pick<ReturnType<typeof createILinkClient>, 'getUpdates' | 'notifyStart' | 'notifyStop' | 'close'> & Partial<Pick<ReturnType<typeof createILinkClient>, 'getConfig'>>
  signal: AbortSignal
  /** 凭据输入/取消预检在下载前执行；不得通过网络消息中的owner取得权限。 */
  preflight(payload: WechatInboundPayload, pendingMedia: boolean, signal: AbortSignal, items: readonly WechatMediaRequirement[]): Promise<'enqueue' | 'consumed'>
  /** 返回已完成下载、解密、owner授权暂存的真实附件ID；原始AES/CDN描述只留内存。 */
  materialize(items: readonly WechatMediaRequirement[], payload: WechatInboundPayload, signal: AbortSignal): Promise<readonly string[]>
  /** 必须原子去重与持久化，失败重读整个response时不可再次启动同一消息。 */
  enqueue(payload: WechatInboundPayload, signal: AbortSignal): Promise<void>
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  report?(event: 'poll-unavailable' | 'start-notify-unavailable' | 'stop-notify-unavailable' | 'typing-ticket-unavailable', error?: unknown): void
}

/** iLink内存游标按完整响应成功后推进；不替代IM队列和Agent业务。 */
export async function connectWechatPolling(options: WechatPollingOptions): Promise<GatewayConnection> {
  if (!options.botId || !options.ownerId) throw new Error('微信 Gateway 身份无效')
  const cancel = new AbortController()
  const signal = AbortSignal.any([options.signal, cancel.signal])
  const sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) })
  const tickets = typeof options.api.getConfig === 'function' ? createWechatTypingTicketCache({ getConfig: options.api.getConfig }) : null
  const report = (event: Parameters<NonNullable<WechatPollingOptions['report']>>[0], error?: unknown) => {
    try { options.report?.(event, error) } catch { /* 诊断不可打断连接生命周期。 */ }
  }
  try {
    signal.throwIfAborted()
    try { await options.api.notifyStart(signal) }
    catch { if (!signal.aborted) report('start-notify-unavailable') }
    signal.throwIfAborted()
  } catch {
    try { await options.api.close() } catch { /* 不公开上游异常。 */ }
    throw new Error('微信 Gateway 启动失败')
  }
  async function notifyStop(): Promise<void> {
    // 不复用已取消的轮询signal；通知有独立5秒边界。
    const stopped = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        options.api.notifyStop(stopped.signal),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { stopped.abort(); reject(new Error('微信停止通知超时')) }, 5_000) }),
      ])
    } catch { report('stop-notify-unavailable') }
    finally { if (timer) clearTimeout(timer); stopped.abort() }
  }
  async function poll(): Promise<void> {
    let cursor = ''
    try {
      while (!signal.aborted) {
        try {
          const response = await options.api.getUpdates(cursor, signal)
          signal.throwIfAborted()
          if (response.ret !== undefined && response.ret !== null && response.ret !== 0) throw new Error('微信更新失败')
          const messages = response.msgs ?? []
          if (!Array.isArray(messages)) throw new Error('微信更新格式无效')
          for (const raw of messages) {
            signal.throwIfAborted()
            const parsed = parseWechatMessage(raw, { botId: options.botId, ownerId: options.ownerId })
            if (!parsed) continue
            const payload = structuredClone(parsed.payload)
            const preflight = await options.preflight(structuredClone(payload), parsed.mediaItems.length > 0, signal, parsed.mediaItems)
            signal.throwIfAborted()
            if (preflight === 'consumed') continue
            if (preflight !== 'enqueue') throw new Error('微信入站预检结果无效')
            if (parsed.mediaItems.length) {
              const ids = await options.materialize(parsed.mediaItems, structuredClone(payload), signal)
              signal.throwIfAborted()
              if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new Error('微信附件暂存结果无效')
              payload.attachments = [...ids]
            }
            if (!payload.text.trim() && !payload.attachments.length) continue
            if (tickets) {
              const ticket = await tickets.get(payload.platform_user_id, String(payload.context_token || ''), signal)
              if (ticket.status === 'ready') payload.typing_ticket = ticket.ticket
              else report('typing-ticket-unavailable')
            } else report('typing-ticket-unavailable')
            signal.throwIfAborted()
            await options.enqueue(payload, signal)
            signal.throwIfAborted()
          }
          // 与旧Python先推进cursor不同：入队失败不承认整个响应已消费。
          // 崩溃/重读可能重复投递前半批消息，enqueue必须以平台/bot/chat/事件原子去重。
          if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) cursor = response.get_updates_buf
        } catch (error) {
          if (signal.aborted) return
          report('poll-unavailable', error)
          await sleep(3_000, signal)
        }
      }
    } catch {
      if (!signal.aborted) throw new Error('微信 Gateway 轮询失败')
    } finally {
      await notifyStop()
      await tickets?.close()
      try { await options.api.close() } catch { throw new Error('微信 Gateway 清理失败') }
    }
  }
  const closed = poll()
  void closed.catch(() => undefined)
  return { closed, async stop() { cancel.abort(); await closed } }
}
