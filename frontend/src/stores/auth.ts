import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAudioStore } from './audio'
import { authApi } from '@/services/api'
import type { components } from '@/types/api'
import { getLocale } from '@/i18n'
import { clearGreeting } from '@/composables/useGreeting'
import { beginAccountBoundary } from '@/utils/accountBoundary'
import { useUiStore } from './ui'
import { useLiveStore } from './live'
import { useFilesCacheStore } from './filesCache'
import { useProjectStore } from './projects'
import { useMindStore } from './mind'
import { onboardingGuideState } from '@/composables/useOnboardingGuide'
import { onboardingProjectId, onboardingSeedState } from '@/composables/useOnboardingSeed'
import { setUserTimezone } from '@/utils/userTimezone'

type UserResponse = components['schemas']['UserResponse']
// 后端已提供该字段；待下次从最新 OpenAPI 重新生成 api.ts 后可移除交叉类型。
type UserWithTimezone = UserResponse & { timezone?: string | null }

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
const TOKEN_KEY = 'user_token'

function resetAccountState() {
  beginAccountBoundary()
  clearGreeting()
  useAudioStore().stop()
  useUiStore().resetAccountState()
  useLiveStore().resetAccountState()
  useFilesCacheStore().resetAccountState()
  useProjectStore().resetAccountState()
  useMindStore().resetAccountState()
  onboardingProjectId.value = null
  onboardingSeedState.value = null
  onboardingGuideState.value = null
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
  const user  = ref<UserWithTimezone | null>(null)

  const isLoggedIn = computed(() => !!token.value)

  function _saveToken(t: string) {
    token.value = t
    localStorage.setItem(TOKEN_KEY, t)
  }

  function _setUser(u: UserWithTimezone | null) {
    user.value = u
    setUserTimezone(u?.timezone)
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
      credentials: 'include',
      body: JSON.stringify({ username, email, password, locale: getLocale() }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(_extractDetail(body, '注册失败'))
    resetAccountState()
    _saveToken(body.accessToken)
    _setUser(body.user)
  }

  async function login(username: string, password: string) {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(_extractDetail(body, '登录失败'))
    resetAccountState()
    _saveToken(body.accessToken)
    _setUser(body.user)
  }

  async function fetchMe() {
    if (!token.value) return
    try {
      const res = await fetch(`${BASE_URL}/auth/me`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token.value}` },
      })
      // 只有明确的 401 才代表 token 失效。后端短暂 5xx、锁等待或网络中断
      // 不应清掉本地登录态，否则一次服务抖动会把用户误登出。
      if (res.status === 401) { logout(); return }
      if (!res.ok) return
      const nextUser = await res.json() as UserWithTimezone
      user.value = nextUser
      setUserTimezone(nextUser.timezone)
      _syncTimezone()
    } catch {
      // 保留 token，等待下一次请求或用户主动重试。
    }
  }

  // 仅在用户没有手动时区时，把浏览器探测结果回写到 user.timezone（避免每次加载都写）。
  // 后端据此让「今天 / 日期归属」按用户本地算；探测失败则不写，后端回退服务器 LOCAL_TZ。
  // 见 docs/backend/时区与时钟迁移方案.md Phase 3。
  function _syncTimezone() {
    let tz: string | undefined
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return }
    // 已有值表示用户明确选择过时区；只有空值时才自动采用浏览器时区。
    if (!tz || !user.value || user.value.timezone) return
    updateProfile({ timezone: tz }).catch(() => {})   // fire-and-forget，失败不影响主流程
  }

  async function updateProfile(fields: Record<string, unknown>) {
    const updated = await authApi.updateProfile(fields)
    user.value = updated
    setUserTimezone(updated.timezone)
    return updated
  }

  async function uploadAvatar(file: File) {
    const updated = await authApi.uploadAvatar(file)
    user.value = updated
    return updated
  }

  function logout() {
    void fetch(`${BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {})
    useAudioStore().stop()
    resetAccountState()
    token.value = ''
    user.value  = null
    setUserTimezone(null)
    localStorage.removeItem(TOKEN_KEY)
  }

  return { token, user, isLoggedIn, register, login, fetchMe, updateProfile, uploadAvatar, logout }
})
