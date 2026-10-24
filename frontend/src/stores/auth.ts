import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { useAudioStore } from './audio'
import { authApi } from '@/services/api'
import { getCsrfHeaders } from '@/services/api'
import { getAuthDeviceId } from '@/utils/authDevice'
import type { components } from '@/types/api'
import { getLocale } from '@/i18n'
import { clearGreeting } from '@/composables/shared/useGreeting'
import { beginAccountBoundary, getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import { useUiStore } from './ui'
import { useLiveStore } from './live'
import { useFilesCacheStore } from './filesCache'
import { useProjectStore } from './projects'
import { useMindStore } from './mind'
import { usePreviewStore } from './preview'
import { usePreviewBlobCache } from '@/composables/shared/usePreviewBlobCache'
import { onboardingGuideState } from '@/composables/onboarding/useOnboardingGuide'
import { onboardingProjectId, onboardingSeedState } from '@/composables/onboarding/useOnboardingSeed'
import { setUserTimezone } from '@/utils/userTimezone'
import { InteractionSync } from '@/interaction/sync/InteractionSync'

type UserResponse = components['schemas']['UserResponse']

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

function resetAccountState() {
  beginAccountBoundary()
  clearGreeting()
  useAudioStore().stop()
  useUiStore().resetAccountState()
  useLiveStore().resetAccountState()
  useFilesCacheStore().resetAccountState()
  useProjectStore().resetAccountState()
  useMindStore().resetAccountState()
  usePreviewBlobCache().clear()
  usePreviewStore().resetAccountState()
  onboardingProjectId.value = null
  onboardingSeedState.value = null
  onboardingGuideState.value = null
}

export const useAuthStore = defineStore('auth', () => {
  const user  = ref<UserResponse | null>(null)
  const sessionChecked = ref(false)
  const liveStore = useLiveStore()

  // IM 绑定变化通过 live 资源事件通知；重新读取 /auth/me 才能取得后端计算的
  // imChannels，避免页面继续使用登录响应里的空列表。
  watch(() => liveStore.rev.im_channels, revision => {
    if (revision > 0 && user.value) void fetchMe(true)
  })

  const isLoggedIn = computed(() => !!user.value)

  function _setUser(u: UserResponse | null) {
    user.value = u
    setUserTimezone(u?.timezone)
  }

  function _applyUserUpdate(updated: UserResponse) {
    const current = user.value
    // profile/avatar 接口不会计算动态的 imChannels，保留同一账号当前值；
    // 解绑等渠道变化由 /auth/me 的实时刷新负责清空或替换。
    user.value = current?.id === updated.id
      ? { ...updated, imChannels: current.imChannels }
      : updated
  }

  function _extractDetail(body: { detail?: unknown } | null | undefined, fallback: string) {
    const d = body?.detail
    if (!d) return fallback
    if (typeof d === 'string') return d
    if (Array.isArray(d)) return d.map((e: any) => e.msg ?? e).join('；')
    return fallback
  }

  async function register(username: string, email: string, password: string, emailSubscribed = false, verificationCode?: string) {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': getAuthDeviceId(), 'X-Auth-Transport': 'cookie' },
      credentials: 'include',
      body: JSON.stringify({ username, email, password, locale: getLocale(), emailSubscribed, verificationCode }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(_extractDetail(body, '注册失败'))
    resetAccountState()
    _setUser(body.user)
    sessionChecked.value = true
  }

  async function login(username: string, password: string) {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Transport': 'cookie' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(_extractDetail(body, '登录失败'))
    resetAccountState()
    _setUser(body.user)
    sessionChecked.value = true
    await fetchMe(true)
  }

  async function fetchMe(force = false) {
    if (!force && sessionChecked.value && user.value) return true
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      const res = await fetch(`${BASE_URL}/auth/me`, {
        credentials: 'include',
      })
      // 账号切换后，旧请求的成功和 401 都不能改动新账号的登录态。
      if (requestEpoch !== getAccountBoundaryEpoch()) return null
      // 只有明确的 401 才代表 token 失效。后端短暂 5xx、锁等待或网络中断
      // 不应清掉本地登录态，否则一次服务抖动会把用户误登出。
      if (res.status === 401) {
        user.value = null
        sessionChecked.value = true
        setUserTimezone(null)
        return false
      }
      if (!res.ok) return null
      const nextUser = await res.json() as UserResponse
      if (requestEpoch !== getAccountBoundaryEpoch()) return null
      user.value = nextUser
      sessionChecked.value = true
      setUserTimezone(nextUser.timezone)
      _syncTimezone()
      return true
    } catch {
      // 网络异常不清空可能有效的 HttpOnly 会话；允许后续路由再次探测。
      return null
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
    _applyUserUpdate(updated)
    setUserTimezone(updated.timezone)
    return updated
  }

  async function updateProfilePreference(fields: Record<string, unknown>, key: string) {
    const previous = user.value ? { ...user.value } : null
    try {
      return await InteractionSync.execute({
        scope: 'profile.user-preference.update',
        entityKey: `profile:user:${key}`,
        apply: () => {
          if (user.value) user.value = { ...user.value, ...fields }
        },
        rollback: () => { user.value = previous },
        request: () => authApi.updateProfile(fields),
        onCommit: updated => {
          _applyUserUpdate(updated)
          setUserTimezone(updated.timezone)
        },
      })
    } catch {
      return user.value
    }
  }

  async function uploadAvatar(file: File) {
    const updated = await authApi.uploadAvatar(file)
    _applyUserUpdate(updated)
    return updated
  }

  async function logout(): Promise<boolean> {
    let response: Response
    try {
      response = await fetch(`${BASE_URL}/auth/logout`, {
        method: 'POST', credentials: 'include', headers: getCsrfHeaders(), keepalive: true,
      })
    } catch {
      return false
    }
    // 401 表示当前 Cookie 已失效/账号已删除，服务端已不再接受该会话。
    if (!response.ok && response.status !== 401) return false
    useAudioStore().stop()
    resetAccountState()
    user.value  = null
    sessionChecked.value = true
    setUserTimezone(null)
    return true
  }

  return { user, isLoggedIn, sessionChecked, register, login, fetchMe, updateProfile, updateProfilePreference, uploadAvatar, logout }
})
