import { i18n } from '@/i18n'

export function pickGreetingFallback() {
  const fallbacks = i18n.global.tm('greetingUi.fallbacks') as string[]
  return fallbacks[Math.floor(Math.random() * fallbacks.length)] || ''
}
