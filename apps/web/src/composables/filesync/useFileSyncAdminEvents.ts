import { isFileSyncEventPayload } from '@/types/live-events'

type AuthFetch = (url: string, options?: RequestInit) => Promise<Response>

const EVENT_URL = '/api/v1/admin/filesync/events'

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function useFileSyncAdminEvents(authFetch: AuthFetch, onInvalidate: () => void) {
  let controller: AbortController | null = null
  let running = false
  let retry = 0
  const seen = new Set<string>()
  const revisions = new Map<string, number>()

  function consumeLine(line: string) {
    if (!line.startsWith('data:')) return
    const raw = line.slice(5).trim()
    if (!raw) return
    try {
      const event: unknown = JSON.parse(raw)
      if (!isFileSyncEventPayload(event) || seen.has(event.event_id)) return
      const key = event.type === 'filesync.run.changed'
        ? `run:${event.run_id}`
        : `binding:${event.binding_id}`
      const revision = revisions.get(key)
      if (revision != null && event.revision <= revision) return
      seen.add(event.event_id)
      if (seen.size > 512) seen.delete(seen.values().next().value as string)
      revisions.set(key, event.revision)
      onInvalidate()
    } catch {
      // 忽略无效 SSE 行；API 快照仍是任务状态事实来源。
    }
  }

  async function consumeStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (running) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }
  }

  async function connect(signal: AbortSignal): Promise<boolean> {
    const response = await authFetch(EVENT_URL, {
      headers: { Accept: 'text/event-stream' },
      signal,
    })
    if (response.status === 401) return false
    if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`)
    retry = 0
    // 每次连接成功都补读快照，覆盖断线期间及初次订阅前的状态变化。
    onInvalidate()
    await consumeStream(response.body)
    return true
  }

  async function loop() {
    while (running) {
      controller = new AbortController()
      try {
        if (!await connect(controller.signal)) {
          running = false
          return
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') break
      }
      if (!running) break
      retry = Math.min(retry + 1, 6)
      await abortableDelay(Math.min(1000 * 2 ** retry, 30000), controller.signal)
    }
  }

  function start() {
    if (running) return
    running = true
    void loop()
  }

  function stop() {
    running = false
    controller?.abort()
    controller = null
  }

  return { start, stop }
}
