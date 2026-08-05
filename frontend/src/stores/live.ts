/**
 * 实时事件 store：开一条 SSE 订阅后端 `/live/stream`，
 * 收到「资源变了」就递增对应 rev 计数，各视图/store watch 自己的 rev 重新拉数据。
 *
 * 这样咕咕在 web 聊天或 IM（飞书/QQ）里改了项目/日历/文件/客户、或 IM 来了新消息，
 * 网页都能实时刷新，无需手动刷新页面。
 *
 * 用 fetch streaming（非 EventSource）以便带 Authorization 头；断线自动重连（指数退避）。
 */
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { getToken, CLIENT_ID } from '@/services/api'
import { useUiStore } from '@/stores/ui'

// 细粒度会话事件：后端 SSE 推送的会话追加，供 GuguChat 增量追加消息
interface SessionEvent {
  session_id: number | string
  appended: Array<{
    role?: string; text?: string; files?: unknown[]; quoted_text?: string
    platform_user_id?: string | null; platform_user_name?: string | null
    platform_bot_user_id?: string | null
  }>
  origin?: string | null
  _t: number
}

// 文件库细粒度事件：filesCache 据此做「回声抑制 / remove 快路径 / 合并刷新」（见 filesCache.ts）。
// op='remove' 带 kind+id(或 ids) → 本地直接剔除；其余(add/update/移动/批量/重连补刷) → 合并全量刷新。
// origin=发起改动的标签页 client-id：等于自己就是回声，本页已乐观更新过 → 跳过。
export interface FileEvent {
  op: 'remove' | 'refresh'
  kind?: 'file' | 'folder'
  id?: number
  ids?: number[]
  origin?: string | null
  _t: number
}

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
// 'mind' 预留给思维面板：P1 咕咕还不写便签，后端暂不推这个资源，rev.mind 会一直是 0；
// 等 P3 接入咕咕确认式写入后由后端开始推，笔记页/画布这边不用再改。
const RESOURCES = ['projects', 'calendar', 'files', 'clients', 'sessions', 'scheduled_tasks', 'mind']

export const useLiveStore = defineStore('live', () => {
  // 每个资源一个递增计数，视图 watch 它来触发 refetch
  const rev = reactive(Object.fromEntries(RESOURCES.map(r => [r, 0])))
  const connected = ref(false)

  // 细粒度会话事件：{ session_id, appended:[{role,text}], _t }，供 GuguChat 追加消息
  const sessionEvent = ref<SessionEvent | null>(null)
  // 文件库细粒度事件（供 filesCache 消费，见上方 FileEvent 注释）
  const fileEvent = ref<FileEvent | null>(null)
  let _seq = 0

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
  // files 资源额外 poke 一次 fileEvent refresh：filesCache 只订阅 fileEvent（不再订阅 rev.files），
  // 断线期间漏掉的文件改动靠这步全量刷回来（origin=null → 不会被回声抑制）。
  let _catchUpTimers: ReturnType<typeof setTimeout>[] = []
  function _catchUp() {
    _catchUpTimers.forEach(clearTimeout)   // 短时间多次重连不叠加
    _catchUpTimers = RESOURCES.map((r, i) => setTimeout(() => {
      bump(r)
      if (r === 'files') fileEvent.value = { op: 'refresh', origin: null, _t: ++_seq }
    }, 300 + i * 250))
  }

  async function _loop() {
    while (running) {
      const token = getToken()
      if (!token) { await _sleep(1000); continue }
      abort = new AbortController()
      try {
        const res = await fetch(`${BASE_URL}/live/stream`, {
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
        while (running) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n'); buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue   // 跳过 keepalive 注释行
            const raw = line.slice(5).trim(); if (!raw) continue
            try {
              const evt = JSON.parse(raw)
              const resources = evt.resources || []
              for (const r of resources) bump(r)   // 粗信号：预览窗、Trash、项目卡片计数等仍照旧消费
              // 文件库细粒度事件：交给 filesCache 决定回声抑制 / remove 快路径 / 合并刷新
              if (resources.includes('files')) {
                const fo = evt.fileOp
                fileEvent.value = fo && fo.op === 'remove'
                  ? { op: 'remove', kind: fo.kind, id: fo.id, ids: fo.ids, origin: evt.origin ?? null, _t: ++_seq }
                  : { op: 'refresh', origin: evt.origin ?? null, _t: ++_seq }
              }
              if (evt.session_id != null) {
                sessionEvent.value = { session_id: evt.session_id, appended: evt.appended || [], origin: evt.origin ?? null, _t: ++_seq }
              }
              if (evt.notification) {
                uiStore.pushNotification(evt.notification)
              }
            } catch { /* 忽略坏行 */ }
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

  return { rev, connected, sessionEvent, fileEvent, bump, connect, disconnect }
})

function _sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
