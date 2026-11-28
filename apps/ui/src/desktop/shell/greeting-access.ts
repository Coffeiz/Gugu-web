import { getLocale } from '@/i18n'
import { pickGreetingFallback } from '@/utils/greetingText'
import type { ChatGreetingAccess } from '@/components/common/gugu-chat/composables/useChatConversation'
import { requestDesktopAgentSessions } from './agent-session-transport'

const cacheMs = 10 * 60_000

export function createDesktopGreetingAccess(): ChatGreetingAccess {
  type Locale = ReturnType<typeof getLocale>
  const cached = new Map<Locale, { text: string; expiresAt: number }>()
  const inFlight = new Map<Locale, Promise<void>>()

  return {
    prefetch() {
      const locale = getLocale()
      if ((cached.get(locale)?.expiresAt ?? 0) > Date.now()) return Promise.resolve()
      const pending = inFlight.get(locale)
      if (pending) return pending
      const request = requestDesktopAgentSessions({ action: 'greeting', locale })
        .then(({ text }) => {
          if (text.trim()) cached.set(locale, { text, expiresAt: Date.now() + cacheMs })
        })
        .catch(() => { /* 模型未配置或暂不可用时沿用通用问候，下次新对话可重试。 */ })
        .finally(() => { inFlight.delete(locale) })
      inFlight.set(locale, request)
      return request
    },
    read() {
      const entry = cached.get(getLocale())
      return entry && entry.expiresAt > Date.now() ? entry.text : pickGreetingFallback()
    },
  }
}
