import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { RunEvent } from '@gugu/core/agent'
import { createImChartParser, validImChartPng, type ImChartRenderer } from '../../runtime/chart-parser.js'
import type { QqProjectionOptions } from './persistent.js'
import type { createQqSender, QqReceipt, QqTarget } from './sender.js'
import { QqMediaUploadError, type createQqMediaUploader } from './media-upload.js'

const MAX_PREFETCHED_CHARTS = 4
let renderTail: Promise<unknown> = Promise.resolve()

/** 预读只准备 PNG。平台操作仍由持久投影按事件顺序执行。 */
export function createQqChartPreparation(
  authorize: () => Promise<boolean>,
  render: ImChartRenderer,
  send: (png: Uint8Array) => Promise<QqReceipt>,
): NonNullable<QqProjectionOptions['charts']> {
  const lifetime = new AbortController()
  let active: Promise<readonly (Uint8Array | null)[]> | undefined
  const pending = new Map<string, ReturnType<ImChartRenderer>>()
  const key = (request: Parameters<ImChartRenderer>[0]) =>
    createHash('sha256').update(JSON.stringify(request)).digest('hex')

  const enqueue: ImChartRenderer = (request, signal) => {
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])
    const result = renderTail.then(async () => {
      if (combined.aborted || !await authorize() || combined.aborted) return []
      active = render(request, combined)
      try { return await active } finally { active = undefined }
    }).catch(() => [])
    renderTail = result
    return result
  }

  const prefetch: ImChartRenderer = async (request) => {
    if (pending.size < MAX_PREFETCHED_CHARTS && !lifetime.signal.aborted) {
      const digest = key(request)
      if (!pending.has(digest)) pending.set(digest, enqueue(request))
    }
    return []
  }

  return {
    send,
    parser(checkpoint) {
      const parser = createImChartParser({ checkpoint, renderCharts(request, signal) {
        const digest = key(request)
        const prepared = pending.get(digest)
        pending.delete(digest)
        return prepared ?? enqueue(request, signal)
      } })
      return {
        snapshot: parser.snapshot,
        async push(event) {
          if (event.type === 'token' && typeof event.payload.text === 'string') return parser.append(event.payload.text)
          return event.type === 'final' ? parser.finish() : []
        },
      }
    },
    prepare(events: AsyncIterable<RunEvent>): AsyncIterable<RunEvent> {
      async function* observe() {
        let projector = createImChartParser({ renderCharts: prefetch })
        let round: number | undefined
        let afterRound = false
        for await (const event of events) {
          if (round !== event.round || (afterRound && event.type === 'token')) {
            projector = createImChartParser({ renderCharts: prefetch })
            round = event.round
            afterRound = false
          }
          if (event.type === 'token' && typeof event.payload.text === 'string') await projector.append(event.payload.text)
          else if (event.type === 'round_end') afterRound = true
          else if (event.type === 'tool_call' || event.type === 'run_waiting' || event.type === 'interaction_required') {
            await projector.finish()
            projector = createImChartParser({ renderCharts: prefetch })
          }
          yield event
        }
      }
      return Readable.from(observe(), { objectMode: true, highWaterMark: 128 })
    },
    async close() {
      lifetime.abort()
      pending.clear()
      // 排队任务看到 abort 后跳过，无需等待其他会话的渲染。
      await active?.catch(() => undefined)
    },
  }
}

/** 上传成功只取得媒体凭据，仍以消息发送回执确定是否已投递。 */
export async function sendQqChart(options: {
  png: Uint8Array
  target: QqTarget
  uploader: Pick<ReturnType<typeof createQqMediaUploader>, 'upload'>
  sender: Pick<ReturnType<typeof createQqSender>, 'media'>
  authorize(): Promise<boolean>
  signal?: AbortSignal
}): Promise<QqReceipt> {
  const { png, target, uploader, sender, authorize, signal } = options
  if (target.chatType !== 'c2c' || !validImChartPng(png) || signal?.aborted || !await authorize())
    return { outcome: 'rejected', platformMessageIds: [] }
  try {
    const uploaded = await uploader.upload({
      target: 'users', openid: target.id, fileType: 1, data: png, fileName: 'chart.png', authorize, signal,
    })
    if (typeof uploaded.file_info !== 'string' || !uploaded.file_info)
      return { outcome: 'unknown', platformMessageIds: [] }
    return await sender.media(target, { fileInfo: uploaded.file_info, image: true }, signal, authorize)
  } catch (error) {
    return { outcome: error instanceof QqMediaUploadError && error.outcome === 'FAILED_CONFIRMED' ? 'rejected' : 'unknown', platformMessageIds: [] }
  }
}
