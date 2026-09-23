// 对话框默认问候：进入「全新对话（无可恢复会话）」时后台预取一次。
// 后端按用户和语言做 10 分钟 Redis 缓存；这里的内存状态只负责页面内去重和账号切换隔离。
// 由 GuguChat onMounted 据 SESSION_KEY 决定——刷新停在老会话时不生成（问候那时根本不显示）。
// 打开对话框时以打字机动画显示；生成没好/失败 → 从兜底池随机取一条（兜底同样走打字机）。文案不自我介绍、不报菜单。
import { ref } from 'vue'
import { agentApi, getToken } from '@/services/api'
import { i18n } from '@/i18n'

function pickFallback() {
  const fallbacks = i18n.global.tm('greetingUi.fallbacks') as string[]
  return fallbacks[Math.floor(Math.random() * fallbacks.length)] || ''
}

// 生成好的问候（响应式，仅本次页面生命周期；跨刷新复用由后端缓存负责）
export const greeting = ref('')
export const greetingEnabled = ref(true)
let greetingOwnerToken = ''
let greetingRequestVersion = 0
let greetingLoaded = false
let greetingRequest: Promise<void> | null = null

/** 切换账号时清掉内存中的账号专属问候，并使旧请求失效。 */
export function clearGreeting() {
  greeting.value = ''
  greetingEnabled.value = true
  greetingOwnerToken = ''
  greetingRequestVersion += 1
  greetingLoaded = false
  greetingRequest = null
}

// 挂载时后台预取一次（fire-and-forget，不阻塞）
export async function prefetchGreeting() {
  const token = getToken()
  if (!token) {
    clearGreeting()
    return
  }
  if (greetingOwnerToken !== token) {
    greeting.value = ''
    greetingEnabled.value = true
    greetingOwnerToken = token
    greetingRequestVersion += 1
    greetingLoaded = false
  }
  if (greetingLoaded) return
  if (greetingRequest) return greetingRequest
  const requestVersion = greetingRequestVersion
  const currentRequest = greetingRequest = (async () => {
    try {
      const response = await agentApi.greeting()
      if (getToken() !== token || greetingRequestVersion !== requestVersion) return
      greetingEnabled.value = response.enabled !== false
      greetingLoaded = true
      if (!greetingEnabled.value) {
        greeting.value = ''
        return
      }
      const t = (response.text || '').trim()
      if (t) greeting.value = t
    } catch {
      // 后端不可用时保留静态兜底，但不覆盖服务端明确下发的关闭状态。
      if (getToken() === token && greetingRequestVersion === requestVersion) {
        greetingEnabled.value = true
        greetingLoaded = true
      }
    }
  })()
  try {
    await greetingRequest
  } finally {
    if (greetingRequest === currentRequest) greetingRequest = null
  }
}

// 取问候：有生成版用生成版，否则随机兜底；管理员关闭时返回空文本。
export function getGreeting() {
  return greetingEnabled.value ? (greeting.value || pickFallback()) : ''
}
