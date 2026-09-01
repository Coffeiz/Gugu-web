import { ref } from 'vue'

/** 当前登录用户的时间口径；为空时才回退浏览器时区。 */
export const userTimezone = ref<string | null>(null)

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

export function effectiveTimezone(): string {
  return userTimezone.value || browserTimezone()
}

export function setUserTimezone(value: string | null | undefined) {
  userTimezone.value = value || null
}
