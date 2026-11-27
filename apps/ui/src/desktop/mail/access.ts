import type { MailAccountSummary, MailOAuthProvider } from '@gugu/email/contracts'
import type { MailAccess } from '@/api/mail'
import { nativeDesktopBridge, requestDesktopMail } from '../bridge/bridge'

export const desktopMailAccess: MailAccess = {
  oauth: {
    preview: !nativeDesktopBridge(),
    async providers() {
      if (!nativeDesktopBridge()) return []
      const result = await requestDesktopMail({ action: 'oauthProviders' })
      return Array.isArray(result) ? result.filter((item): item is MailOAuthProvider => item === 'outlook' || item === 'gmail') : []
    },
    async connect(provider, email, accountId) {
      return await requestDesktopMail({ action: 'oauthConnect', provider, email, accountId }) as MailAccountSummary
    },
  },
  async request<T>(command: Parameters<MailAccess['request']>[0]) {
    return await requestDesktopMail(command) as T
  },
}
