import { renderAgentCharts } from '../../../../agent/charts.js'
import { randomUUID } from 'node:crypto'
import { FeishuApiError, type createFeishuClient } from '@gugu/gateway/feishu'
import { buildFeishuStreamingCard, createFeishuSender, type FeishuDeliveryReceipt } from '@gugu/gateway/feishu'
import type { RunEvent } from '@gugu/core/agent'
import { FeishuPresentation, type FeishuToolSummaryPolicy } from '@gugu/gateway/feishu'
import { createFeishuRunEventProjector, type FeishuStreamFinal, type FeishuStreamEvent } from '@gugu/gateway/feishu'
import { validImChartPng as validFeishuChartPng, type ImChartRenderer as FeishuChartRenderer } from '@gugu/gateway'
import type { ChartRequest } from '@gugu/charts/render'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const chars = (value: string): number => [...value].length
const segment = /^[A-Za-z0-9_-]{1,256}$/

export interface FeishuStreamOptions {
  placeholder?: string; showIntermediateReplies?: boolean; signal?: AbortSignal
  toolSummary?: FeishuToolSummaryPolicy
}
export interface FeishuStreamReceipt extends FeishuDeliveryReceipt {
  /** 只有平台明确返回消息ID才确认可见；false与unknown组合仍严禁重发。 */
  visible: boolean
  cardId: string | null
  final: FeishuStreamFinal | null
}

function definitelyRejected(error: unknown): boolean {
  return error instanceof FeishuApiError && (error.operation === 'auth' || error.errorCode !== undefined && error.errorCode !== 0 ||
    error.statusCode !== undefined && error.statusCode >= 300 && error.statusCode < 500)
}
function fallbackText(text: string, hasFiles: boolean): string { return text.trim() || (hasFiles ? '给你～' : '嗯~在的，你说～') }

/** 单次send内按顺序调用同一卡片全部端点，共用单调sequence，不包含Agent循环。 */
export function createFeishuStreamingSender(options: {
  client: Pick<ReturnType<typeof createFeishuClient>, 'call'>
  sender?: Pick<ReturnType<typeof createFeishuSender>, 'card' | 'text'> & Partial<Pick<ReturnType<typeof createFeishuSender>, 'uploadImage'>>
  now?(): number
  generateId?(): string
}) {
  const sender = options.sender ?? createFeishuSender({ client: options.client })
  const now = options.now ?? (() => performance.now())
  const uuid = options.generateId ?? (() => randomUUID().replaceAll('-', ''))
  async function send(receiveId: string, events: AsyncIterable<FeishuStreamEvent>, args: FeishuStreamOptions = {}): Promise<FeishuStreamReceipt> {
      let cardId: string | null = null, visible = false, healthy = true, consumed = true, canFallback = false
      let sourceFailed = false, sourceError: unknown
      let platformMessageIds: readonly string[] = [], accumulated = '', final: FeishuStreamFinal | null = null
      let sequence = 0, patchedLength = 0, patchedAt = now()
      let presentation = new FeishuPresentation(args.toolSummary)
      const card = (text: string, title = '咕咕思考中', streaming = true, elements?: ObjectValue[]) => {
        const value = buildFeishuStreamingCard(text, title, streaming)
        if (elements) value.body = { elements }
        return value
      }
      const call = (method: 'PUT' | 'PATCH', path: string, body: ObjectValue) => options.client.call(method, path, { body, signal: args.signal })
      const writeElements = async (elements: ObjectValue[]) => {
        try { await call('PUT', `/open-apis/cardkit/v1/cards/${cardId}`, { card: { type: 'card_json', data: JSON.stringify(card('', '咕咕思考中', true, elements)) }, sequence: ++sequence }); return true }
        catch { return false }
      }
      const patch = async (text: string) => {
        try { await call('PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/${presentation.used ? presentation.activeId : 'markdown_1'}/content`, { content: text, sequence: ++sequence, uuid: uuid() }); return true }
        catch { return false }
      }
      try {
        const response = await options.client.call('POST', '/open-apis/cardkit/v1/cards', {
          body: { type: 'card_json', data: JSON.stringify(buildFeishuStreamingCard(args.placeholder ?? '咕咕正在想…')) }, signal: args.signal,
        })
        const id = object(response.data) ? response.data.card_id : undefined
        if (typeof id === 'string' && segment.test(id)) cardId = id
        if (cardId) {
          const bridge = await sender.card(receiveId, { type: 'card', data: { card_id: cardId } }, args.signal)
          platformMessageIds = bridge.platformMessageIds
          visible = bridge.outcome === 'accepted'
          canFallback = bridge.outcome === 'rejected'
        }
      } catch (error) { canFallback = definitelyRejected(error) }
      patchedAt = now()
      try {
        for await (const event of events) {
          if (event.type === 'token' && typeof event.text === 'string') {
            accumulated += event.text
            const created = presentation.append(event.text)
            const activeText = presentation.used ? presentation.activeText : accumulated
            const length = chars(activeText), timestamp = now()
            if (visible && healthy && presentation.used && created) {
              healthy = await writeElements(presentation.elements()); patchedAt = timestamp; patchedLength = length
            } else if (visible && healthy && (timestamp - patchedAt >= 200 || length - patchedLength >= 30)) {
              healthy = await patch(activeText)
              patchedAt = timestamp
              patchedLength = length
            }
          } else if (event.type === 'final' && typeof event.text === 'string') final = structuredClone(event)
          else if (event.type === 'round_end') presentation.endRound()
          else if (event.type === 'tool_call' || event.type === 'tool_done') {
            if (presentation.tool(event) && visible && healthy) healthy = await writeElements(presentation.elements())
            patchedAt = now(); patchedLength = chars(presentation.activeText)
          } else if (event.type === 'chart_image') {
            if (visible && healthy && sender.uploadImage && validFeishuChartPng(event.png)) {
              let uploaded: Awaited<ReturnType<NonNullable<typeof sender.uploadImage>>> | undefined
              try { uploaded = await sender.uploadImage(event.png, args.signal) } catch { /* 源码已经可见；上传失败不删除原文。 */ }
              if (uploaded?.imageKey) {
                const candidate = presentation.copy()
                if (candidate.replace(event.source, uploaded.imageKey)) {
                  healthy = await writeElements(candidate.elements())
                  if (healthy) { presentation = candidate; patchedAt = now(); patchedLength = chars(presentation.activeText) }
                }
              }
            }
          }
          else { consumed = false; healthy = false }
        }
      } catch (error) { consumed = false; sourceFailed = true; sourceError = error }
      // 无论平台更新是否失败均消费至自然结束，释放Runner的session gate。
      if (!visible) {
        // 业务生成器失败不是平台投递未知；不得吞掉错误或将部分输出补发为正常回复。
        if (sourceFailed) throw sourceError
        if (!canFallback || !consumed || args.signal?.aborted) return { outcome: 'unknown', platformMessageIds, visible, cardId, final }
        const text = final?.cancelled ? accumulated.trim() : fallbackText(final ? final.text : args.showIntermediateReplies === false ? '' : accumulated, !!final?.hasFiles)
        if (!text) return { outcome: 'rejected', platformMessageIds: [], visible: false, cardId, final }
        let fallback = text
        if (args.toolSummary && presentation.used) {
          presentation.finish(text, !!final?.cancelled)
          // 未建立流卡时仍保留旧版开启工具展示的文字回退；只展现已按群/私聊策略裁剪脱敏的字段。
          fallback = presentation.plainText()
        }
        const result = await sender.text(receiveId, fallback, args.signal)
        return { ...result, visible: result.outcome === 'accepted', cardId, final }
      }
      const text = final?.cancelled ? accumulated : final ? fallbackText(final.text || accumulated, !!final.hasFiles) : accumulated
      if (presentation.used) presentation.finish(text, !!final?.cancelled)
      if (healthy && text) healthy = presentation.used ? await writeElements(presentation.elements()) : await patch(text)
      let closed = healthy
      if (healthy || sourceFailed) {
        if (text) {
          let preview = text.trim()
          if (chars(preview) > 80) preview = [...preview].slice(0, 77).join('') + '...'
          try { await call('PATCH', `/open-apis/cardkit/v1/cards/${cardId}/settings`, {
            settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: preview || '✅' } } }), sequence: ++sequence, uuid: uuid(),
          }) } catch { closed = false }
        }
        // 即使settings失败也保留Python的整卡收尾尝试，共用前面的sequence。
        try { await call('PUT', `/open-apis/cardkit/v1/cards/${cardId}`, {
          card: { type: 'card_json', data: JSON.stringify(card(text, '咕咕', false, presentation.used ? presentation.elements() : undefined)) }, sequence: ++sequence,
        }) } catch { closed = false }
      }
      // 已可见卡片尽可能关闭后，把原始业务异常交还Runner调用方；收尾错误不覆盖它。
      if (sourceFailed) throw sourceError
      return { outcome: healthy && closed && consumed ? 'accepted' : 'unknown', platformMessageIds, visible, cardId, final }
    }
  return {
    send,
    /** 平台组件入口；只能由单一授权/持久收据投递器调用，禁止observeRun旁路重复发送。 */
    sendRun(receiveId: string, events: AsyncIterable<RunEvent>, args: FeishuStreamOptions & { renderCharts?: FeishuChartRenderer; theme?: ChartRequest['theme'] } = {}) {
      const projector = createFeishuRunEventProjector({ ...args, renderCharts: args?.renderCharts ?? renderAgentCharts })
      async function* project(): AsyncIterable<FeishuStreamEvent> { for await (const event of events) yield* await projector.push(event) }
      return send(receiveId, project(), args)
    },
  }
}
