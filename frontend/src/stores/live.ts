/**
 * 实时事件 store：开一条 SSE 订阅 FastAPI `/api/v1/live/stream`，
 * 收到「资源变了」就递增对应 rev 计数，各视图/store watch 自己的 rev 重新拉数据。
 *
 * 这样咕咕在 web 聊天或 IM（飞书/QQ）里改了项目/日历/文件/客户、或 IM 来了新消息，
 * 网页都能实时刷新，无需手动刷新页面。
 *
 * 用 fetch streaming（非 EventSource）以便带 Authorization 头；断线自动重连（指数退避）。
 */
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { getToken } from '@/services/api'
import { useUiStore } from '@/stores/ui'
import { isLiveEventPayload, type LiveEventPayload } from '@/types/live-events'

// live 事件与业务 API 使用同一 FastAPI owner，避免回退到已移除的 TS Live 服务。
const LIVE_URL = '/api/v1/live/stream'
const RESOURCES = ['projects', 'calendar', 'files', 'clients', 'sessions', 'scheduled_tasks', 'mind', 'terminals', 'im_channels']

export const useLiveStore = defineStore('live', () => {
  // 每个资源一个递增计数，视图 watch 它来触发 refetch
  const rev = reactive(Object.fromEntries(RESOURCES.map(r => [r, 0])))
  const connected = ref(false)

  // 所有实时变化统一通过 canonical 事件传递；业务 store 自己决定增量应用或重拉。
  const resourceEvent = ref<(LiveEventPayload & { _t: number }) | null>(null)
  let _seq = 0
  const seenEventIds = new Set<string>()
  const lastCanonicalRevision = new Map<string, number>()

  // 同步拿 uiStore（Pinia 允许在 setup 里调其他 store）
  const uiStore = useUiStore()

  let abort: AbortController | null = null   // 当前连接的 AbortController
  let running = false     // 是否应保持连接（登录中）
  let retry = 0           // 重连退避计数
  let everConnected = false   // 是否曾连上过：重连成功时据此 catch-up（首次连接不用）

  function bump(resource: string) {
    if (resource in rev) rev[resource]++
  }

  // 重连补刷：错峰逐个 bump，别在回到前台那一帧挤爆主线程（见 _loop 注释）。
  // 断线期间漏掉的变更靠各资源的 rev 补刷回来。
  let _catchUpTimers: ReturnType<typeof setTimeout>[] = []
  function _catchUp() {
    _catchUpTimers.forEach(clearTimeout)   // 短时间多次重连不叠加
    _catchUpTimers = RESOURCES.map((r, i) => setTimeout(() => {
      bump(r)
    }, 300 + i * 250))
  }

  async function _loop() {
    while (running) {
      const token = getToken()
      if (!token) { await _sleep(1000); continue }
      abort = new AbortController()
      try {
        const res = await fetch(LIVE_URL, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`live stream ${res.status}`)
        connected.value = true
        retry = 0
        // 重连成功 → 补上断线期间漏掉的变更（SSE 不补发历史事件；后端 reload / 网络抖动 / 久置标签页
        // 断开期间咕咕改的文件等，靠这步刷出来）。**但错峰 + 延后**：久置标签页回到前台那一下，若 5 个
        // 资源同时 refetch + 替换大数组 + 重渲染，会卡住主线程约 1 秒。逐个延迟 bump，把这波刷新摊开、
        // 让出主线程，回来就不卡了（总量不变、只是不挤在一帧）。
        if (everConnected) _catchUp()
        everConnected = true
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let sseEvent = ''
        while (running) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n'); buf = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('event:')) {
              sseEvent = line.slice(6).trim()
              continue
            }
            if (!line.startsWith('data:')) {
              if (!line.trim()) sseEvent = ''
              continue   // 跳过 keepalive 注释行
            }
            const raw = line.slice(5).trim(); if (!raw) continue
            try {
              const evt = JSON.parse(raw)
              if (sseEvent === 'account_suspended') {
                uiStore.pushNotification({ title: '账号暂时不可用', content: evt.message || '请联系管理员处理。', persist: false, bubble: true })
                running = false
                break
              }
              if (isLiveEventPayload(evt)) {
                const canonical = evt as LiveEventPayload
                if (seenEventIds.has(canonical.event_id)) continue
                seenEventIds.add(canonical.event_id)
                if (seenEventIds.size > 512) {
                  const oldest = seenEventIds.values().next().value
                  if (typeof oldest === 'string') seenEventIds.delete(oldest)
                }
                const previousRevision = lastCanonicalRevision.get(canonical.resource)
                if (previousRevision != null && canonical.revision <= previousRevision) continue
                if (previousRevision != null && canonical.revision > previousRevision + 1) bump(canonical.resource)
                lastCanonicalRevision.set(canonical.resource, canonical.revision)
                resourceEvent.value = { ...canonical, _t: ++_seq }
                bump(canonical.resource)
              }
              if (evt.notification) {
                uiStore.pushNotification(evt.notification)
              }
            } catch { /* 忽略坏行 */ }
            sseEvent = ''
          }
        }
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') break
        // 连接断开（后端重启/网络抖动）→ 退避重连
      } finally {
        connected.value = false
      }
      if (!running) break
      retry = Math.min(retry + 1, 6)
      await _sleep(Math.min(1000 * 2 ** retry, 30000))
    }
  }

  function connect() {
    if (running) return
    running = true
    _loop()
  }

  function disconnect() {
    running = false
    connected.value = false
    if (abort) { abort.abort(); abort = null }
  }

  function resetAccountState() {
    disconnect()
    Object.keys(rev).forEach(resource => { rev[resource] = 0 })
    resourceEvent.value = null
    seenEventIds.clear()
    lastCanonicalRevision.clear()
    _catchUpTimers.forEach(clearTimeout)
    _catchUpTimers = []
    retry = 0
    everConnected = false
  }

  return { rev, connected, resourceEvent, bump, connect, disconnect, resetAccountState }
})

function _sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
