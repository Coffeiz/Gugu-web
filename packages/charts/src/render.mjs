import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MAX_SOURCE_CHARS = 20_000
const MAX_CHARTS = 4
const MAX_PNG_BYTES = 3 * 1024 * 1024
const WORKER_HEADER_BYTES = 8
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


/** 每次仅向隔离子进程交付一张图，回收后仍接着处理同一批的下一张。 */
export function createChartRenderer({
  path = workerPath,
  idleMs = 60_000,
  maxCharts = 64,
  maxRssBytes = 350 * 1024 ** 2,
  timeoutMs = RENDER_TIMEOUT_MS,
} = {}) {
  let worker
  let tail = Promise.resolve()
  let idleTimer

  function setReferenced(child, referenced) {
    const method = referenced ? 'ref' : 'unref'
    child[method]()
    child.stdin[method]?.()
    child.stdout[method]?.()
    child.stderr[method]?.()
  }

  function retire(instance) {
    if (!instance.stopping) {
      instance.stopping = true
      instance.child.kill('SIGKILL')
    }
  }

  function start() {
    const child = spawn(process.execPath, [path, '--persistent'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const instance = { child, charts: 0, stopping: false, pending: null, closed: null }
    instance.closed = new Promise(resolve => {
      child.once('close', () => {
        instance.stopping = true
        instance.pending?.finish(new ChartRenderError('worker_failed'))
        resolve()
      })
    })
    child.on('error', () => {
      retire(instance)
      instance.pending?.finish(new ChartRenderError('worker_unavailable'))
    })
    child.stdin.on('error', () => {
      retire(instance)
      instance.pending?.finish(new ChartRenderError('worker_input_failed'))
    })
    child.stdout.on('data', chunk => {
      const pending = instance.pending
      if (pending && !instance.stopping) pending.read(chunk)
      else retire(instance)
    })
    child.stderr.resume()
    return instance
  }

  async function current(signal) {
    if (worker?.stopping) {
      setReferenced(worker.child, true)
      await worker.closed
      worker = undefined
    }
    signal.throwIfAborted()
    worker ??= start()
    setReferenced(worker.child, true)
    return worker
  }

  function renderOne(instance, input, signal) {
    return new Promise((resolve, reject) => {
      let bytes = 0
      const chunks = []
      let expected
      const finish = (error, png) => {
        if (!instance.pending) return
        instance.pending = null
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(png)
      }
      const fail = code => {
        retire(instance)
        finish(new ChartRenderError(code))
      }
      const abort = () => {
        retire(instance)
        finish(signal.reason)
      }
      instance.pending = {
        finish,
        read(chunk) {
          bytes += chunk.byteLength
          if (bytes > MAX_PNG_BYTES + WORKER_HEADER_BYTES) return fail('worker_output_too_large')
          chunks.push(chunk)
          if (bytes < WORKER_HEADER_BYTES) return
          if (expected === undefined) {
            const header = Buffer.concat(chunks, bytes)
            expected = header.readUInt32BE() + WORKER_HEADER_BYTES
            if (expected > MAX_PNG_BYTES + WORKER_HEADER_BYTES) return fail('invalid_worker_png_size')
          }
          if (bytes < expected) return
          if (bytes > expected) return fail('invalid_worker_trailing_data')
          const frame = Buffer.concat(chunks, bytes)
          const rss = frame.readUInt32BE(4)
          const png = frame.subarray(WORKER_HEADER_BYTES)
          if (!rss || (png.length && !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)))
            return fail('invalid_worker_frame')
          if (++instance.charts >= maxCharts || rss >= maxRssBytes) retire(instance)
          finish(null, png.length ? png : null)
        },
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else instance.child.stdin.write(input)
    })
  }

  async function run(inputs, signal) {
    signal?.throwIfAborted()
    clearTimeout(idleTimer)
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new ChartRenderError('render_timeout')), timeoutMs)
    const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])])
    try {
      const result = []
      for (const input of inputs) result.push(await renderOne(await current(combined), input, combined))
      return result
    } finally {
      clearTimeout(timer)
      if (worker) {
        const instance = worker
        idleTimer = setTimeout(() => retire(instance), idleMs)
        idleTimer.unref()
        setReferenced(instance.child, false)
      }
    }
  }

  return async function renderCharts(request, { signal } = {}) {
    validateRequest(request)
    if (!request.charts.length) return []
    signal?.throwIfAborted()
    const encoded = JSON.stringify(request)
    if (Buffer.byteLength(encoded) > MAX_SOURCE_CHARS * MAX_CHARTS * 4 + 1024)
      throw new RangeError('图表请求超过输入限制')
    const { charts, theme } = JSON.parse(encoded)
    const inputs = charts.map(chart => JSON.stringify({ charts: [chart], theme }) + '\n')
    const result = tail.then(() => run(inputs, signal))
    tail = result.then(() => undefined, () => undefined)
    if (!signal) return result
    // 排队取消立即返回，已取消的请求在到队首后也不会启动 worker。
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}

export const renderCharts = createChartRenderer()
