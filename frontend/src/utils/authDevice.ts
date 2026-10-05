const DEVICE_ID_KEY = 'gugu.auth.device-id'
let fallbackDeviceId = ''

function createDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  }
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 匿名认证请求共享的持久设备标识，只用于限流分桶。 */
export function getAuthDeviceId(): string {
  if (typeof window === 'undefined') return ''
  try {
    const stored = window.localStorage.getItem(DEVICE_ID_KEY)
    if (stored && /^[A-Za-z0-9_-]{16,128}$/.test(stored)) return stored
    const created = createDeviceId()
    window.localStorage.setItem(DEVICE_ID_KEY, created)
    return created
  } catch {
    if (!fallbackDeviceId) fallbackDeviceId = createDeviceId()
    return fallbackDeviceId
  }
}
