import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MAX_SOURCE_CHARS = 20_000
const MAX_CHARTS = 4
const MAX_PNG_BYTES = 3 * 1024 * 1024
const MAX_STDOUT_BYTES = MAX_CHARTS * (MAX_PNG_BYTES + 4)
const RENDER_TIMEOUT_MS = 30_000
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url))

export class ChartRenderError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ChartRenderError'
    this.code = code
  }
}

function validateRequest(request) {
  if (!request || !Array.isArray(request.charts)) throw new TypeError('charts 必须是数组')
  if (request.charts.length > MAX_CHARTS) throw new RangeError('图表数量超过限制')
  for (const chart of request.charts) {
    if (!chart || !['mermaid', 'math'].includes(chart.type)) throw new TypeError('图表类型无效')
    if (typeof chart.source !== 'string' || !chart.source || chart.source.length > MAX_SOURCE_CHARS) {
      throw new RangeError('图表源码无效或超过长度限制')
    }
  }
}

function parseFrames(buffer, count) {
  const rendered = []
  let offset = 0
  for (let index = 0; index < count; index += 1) {
    if (buffer.length - offset < 4) throw new ChartRenderError('invalid_worker_frame')
    const size = buffer.readUInt32BE(offset)
    offset += 4
    if (size > MAX_PNG_BYTES || buffer.length - offset < size) {
      throw new ChartRenderError('invalid_worker_png_size')
    }
    if (size === 0) {
      rendered.push(null)
      continue
    }
    const png = buffer.subarray(offset, offset + size)
    offset += size
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new ChartRenderError('invalid_worker_png')
    }
    rendered.push(Buffer.from(png))
  }
  if (offset !== buffer.length) throw new ChartRenderError('invalid_worker_trailing_data')
  return rendered
}

/** 经独立 Node worker 栅格化；子进程隔离、大小上限、超时和取消与旧调用链一致。 */
export async function renderCharts(request, { signal } = {}) {
  validateRequest(request)
  if (request.charts.length === 0) return []
  signal?.throwIfAborted()
  const input = Buffer.from(JSON.stringify(request), 'utf8')
  if (input.byteLength > MAX_SOURCE_CHARS * MAX_CHARTS * 4 + 1024) {
    throw new RangeError('图表请求超过输入限制')
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    let outputBytes = 0
    const output = []
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => {
      child.kill('SIGKILL')
      finish(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new ChartRenderError('render_timeout'))
    }, RENDER_TIMEOUT_MS)
    timer.unref?.()

    child.stdout.on('data', chunk => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL')
        finish(new ChartRenderError('worker_output_too_large'))
        return
      }
      output.push(chunk)
    })
    child.stderr.on('data', () => {})
    child.once('error', () => finish(new ChartRenderError('worker_unavailable')))
    child.once('close', code => {
      if (settled) return
      if (code !== 0) {
        finish(new ChartRenderError('worker_failed'))
        return
      }
      try {
        finish(null, parseFrames(Buffer.concat(output), request.charts.length))
      } catch (error) {
        finish(error instanceof Error ? error : new ChartRenderError('invalid_worker_output'))
      }
    })
    child.stdin.once('error', () => {
      child.kill('SIGKILL')
      finish(new ChartRenderError('worker_input_failed'))
    })
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin.end(input)
    if (signal?.aborted) abort()
  })
}
