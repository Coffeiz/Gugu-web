import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAudioStore } from './audio'
import { authApi } from '@/services/api'
import type { components } from '@/types/api'

type UserResponse = components['schemas']['UserResponse']

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
const TOKEN_KEY = 'user_token'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
  const user  = ref<UserResponse | null>(null)

  const isLoggedIn = computed(() => !!token.value)

  function _saveToken(t: string) {
    token.value = t
    localStorage.setItem(TOKEN_KEY, t)
  }

  function _setUser(u: UserResponse | null) {
    user.value = u
  }

  function _extractDetail(body: { detail?: unknown } | null | undefined, fallback: string) {
    const d = body?.detail
    if (!d) return fallback
    if (typeof d === 'string') return d
    if (Array.isArray(d)) return d.map((e: any) => e.msg ?? e).join('；')
    return fallback
  }

  async function register(username: string, email: string, password: string) {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(_extractDetail(body, '注册失败'))
    _saveToken(body.accessToken)
    _setUser(body.user)
  }

  async function login(username: string, password: string) {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(_extractDetail(body, '登录失败'))
    _saveToken(body.accessToken)
    _setUser(body.user)
  }

  async function fetchMe() {
    if (!token.value) return
    try {
      const res = await fetch(`${BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token.value}` },
      })
      // 只有明确的 401 才代表 token 失效。后端短暂 5xx、锁等待或网络中断
      // 不应清掉本地登录态，否则一次服务抖动会把用户误登出。
      if (res.status === 401) { logout(); return }
      if (!res.ok) return
      user.value = await res.json()
      _syncTimezone()
    } catch {
      // 保留 token，等待下一次请求或用户主动重试。
    }
  }

  // 把浏览器时区回写到 user.timezone——仅当探测到真实 tz 且与已存的不同才 PATCH（避免每次加载都写）。
  // 后端据此让「今天 / 日期归属」按用户本地算；探测失败则不写，后端回退服务器 LOCAL_TZ。
  // 见 docs/backend/时区与时钟迁移方案.md Phase 3。
  function _syncTimezone() {
    let tz: string | undefined
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return }
    if (!tz || !user.value || (user.value as any).timezone === tz) return
    updateProfile({ timezone: tz }).catch(() => {})   // fire-and-forget，失败不影响主流程
  }

  async function updateProfile(fields: Record<string, unknown>) {
    const updated = await authApi.updateProfile(fields)
    user.value = updated
    return updated
  }

  async function uploadAvatar(file: File) {
    const updated = await authApi.uploadAvatar(file)
    user.value = updated
    return updated
  }

  function logout() {
    useAudioStore().stop()
    token.value = ''
    user.value  = null
    localStorage.removeItem(TOKEN_KEY)
  }

  return { token, user, isLoggedIn, register, login, fetchMe, updateProfile, uploadAvatar, logout }
})
