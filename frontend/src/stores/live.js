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
import { getToken } from '@/services/api'
import { useUiStore } from '@/stores/ui'

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
const RESOURCES = ['projects', 'calendar', 'files', 'clients', 'sessions']

export const useLiveStore = defineStore('live', () => {
  // 每个资源一个递增计数，视图 watch 它来触发 refetch
  const rev = reactive(Object.fromEntries(RESOURCES.map(r => [r, 0])))
  const connected = ref(false)

  // 细粒度会话事件：{ session_id, appended:[{role,text}], _t }，供 GuguChat 追加消息
  const sessionEvent = ref(null)
  let _seq = 0

  // 同步拿 uiStore（Pinia 允许在 setup 里调其他 store）
  const uiStore = useUiStore()

  let abort = null        // 当前连接的 AbortController
  let running = false     // 是否应保持连接（登录中）
  let retry = 0           // 重连退避计数

  function bump(resource) {
    if (resource in rev) rev[resource]++
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
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (running) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n'); buf = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data:')) continue   // 跳过 keepalive 注释行
            const raw = line.slice(5).trim(); if (!raw) continue
            try {
              const evt = JSON.parse(raw)
              for (const r of evt.resources || []) bump(r)
              if (evt.session_id != null) {
                sessionEvent.value = { session_id: evt.session_id, appended: evt.appended || [], _t: ++_seq }
              }
              if (evt.notification) {
                uiStore.pushNotification(evt.notification)
              }
            } catch { /* 忽略坏行 */ }
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') break
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

  return { rev, connected, sessionEvent, bump, connect, disconnect }
})

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
