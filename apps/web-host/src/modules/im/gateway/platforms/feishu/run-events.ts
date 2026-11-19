import type { RunEvent } from '@gugu/core/agent'
import type { ChartRequest } from '@gugu/charts/render'
import type { FeishuStreamEvent } from './streaming.js'

export type FeishuChartRenderer = (request: ChartRequest, signal?: AbortSignal) => Promise<readonly (Uint8Array | null)[]>
const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
export const validFeishuChartPng = (bytes: Uint8Array) => bytes instanceof Uint8Array && bytes.byteLength >= 8 && bytes.byteLength <= 3 * 1024 * 1024 && pngSignature.every((byte, index) => bytes[index] === byte)

/** 增量跟踪顶层围栏；源码始终原样透传，渲染失败不能改写canonical正文。 */
export function createFeishuRunEventProjector(options: {
  renderCharts?: FeishuChartRenderer
  theme?: ChartRequest['theme']
  signal?: AbortSignal
  checkpoint?: unknown
} = {}) {
  let line = '', outer: { marker: string; size: number } | null = null
  let chart: { type: 'mermaid' | 'math'; body: string; source: string } | null = null
  if (options.checkpoint !== undefined) {
    const raw = options.checkpoint as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || raw.v !== 1 || typeof raw.line !== 'string'
      || raw.outer !== null && (!raw.outer || typeof raw.outer !== 'object' || !['`', '~'].includes(String((raw.outer as Record<string, unknown>).marker)) || !Number.isSafeInteger((raw.outer as Record<string, unknown>).size) || Number((raw.outer as Record<string, unknown>).size) < 3)
      || raw.chart !== null && (!raw.chart || typeof raw.chart !== 'object' || !['mermaid', 'math'].includes(String((raw.chart as Record<string, unknown>).type))
        || typeof (raw.chart as Record<string, unknown>).body !== 'string' || typeof (raw.chart as Record<string, unknown>).source !== 'string')) throw new Error('飞书图表投影状态无效')
    line = raw.line; outer = structuredClone(raw.outer) as typeof outer; chart = structuredClone(raw.chart) as typeof chart
  }
  const render: FeishuChartRenderer = options.renderCharts ?? (async (request, signal) => (await import('../../../../agent/charts.js')).renderAgentCharts(request, signal))
  async function completedLine(value: string, terminated: boolean): Promise<FeishuStreamEvent[]> {
    const content = value.replace(/\r?\n$/, ''), fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(content)
    if (chart) {
      if (fence && fence[1]![0] === '`' && fence[1]!.length >= 3 && !fence[2]!.trim()) {
        const completed = chart; chart = null
        const source = completed.source + content
        if (!completed.body || [...completed.body].length > 20000) return []
        try {
          const bytes = (await render({ charts: [{ type: completed.type, source: completed.body }], ...(options.theme ? { theme: options.theme } : {}) }, options.signal))[0]
          return bytes && validFeishuChartPng(bytes) ? [{ type: 'chart_image', source, png: bytes }] : []
        } catch { return [] } // 渲染错误仅保留原文，不传播含源码或环境信息的异常。
      }
      chart.source += value; chart.body += value
      // 超限源码保持普通代码围栏，后续内部示例不能被误识别。
      if (chart.body.length > 80000) { chart = null; outer = { marker: '`', size: 3 } }
      return []
    }
    if (!fence) return []
    const marker = fence[1]![0]!, size = fence[1]!.length, info = fence[2]!.trim()
    if (outer) { if (marker === outer.marker && size >= outer.size && !info) outer = null; return [] }
    const language = info.split(/\s+/)[0]!.toLowerCase()
    if (terminated && marker === '`' && size === 3 && ['mermaid', 'tex', 'latex'].includes(language)) chart = { type: language === 'mermaid' ? 'mermaid' : 'math', body: '', source: value }
    else outer = { marker, size }
    return []
  }
  return {
    snapshot(): unknown { return { v: 1, line, outer, chart } },
    /** 调用方须按RunEvent顺序await；不执行平台发送，不新增业务事件或Agent循环。 */
    async push(event: RunEvent): Promise<FeishuStreamEvent[]> {
      const payload = event.payload
      if (event.type === 'token' && typeof payload.text === 'string') {
        const result: FeishuStreamEvent[] = [{ type: 'token', text: payload.text }]
        line += payload.text
        let newline: number
        while ((newline = line.indexOf('\n')) >= 0) { const complete = line.slice(0, newline + 1); line = line.slice(newline + 1); result.push(...await completedLine(complete, true)) }
        return result
      }
      if (event.type === 'tool_call' || event.type === 'tool_done') return [{ type: event.type,
        ...(typeof payload.toolCallId === 'string' ? { toolCallId: payload.toolCallId } : {}),
        ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
        ...('result' in payload ? { result: payload.result } : {}),
      }]
      if (event.type === 'round_end') return [{ type: 'round_end' }]
      if (event.type === 'final') {
        const charts = line ? await completedLine(line, false) : []; line = ''
        return [...charts, { type: 'final', text: typeof payload.text === 'string' ? payload.text : '', cancelled: payload.status === 'cancelled', hasFiles: Array.isArray(payload.files) && payload.files.length > 0 }]
      }
      return []
    },
  }
}
