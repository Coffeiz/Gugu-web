import { inject, type InjectionKey } from 'vue'
import type { MailAccountSummary, MailCommand, MailOAuthProvider } from '@gugu/email/contracts'

export interface MailAccess {
  oauth?: {
    preview?: boolean
    providers(): Promise<MailOAuthProvider[]>
    connect(provider: MailOAuthProvider, email: string, accountId?: string): Promise<MailAccountSummary>
  }
  request<T>(command: MailCommand): Promise<T>
}

export const mailAccessKey: InjectionKey<MailAccess> = Symbol('mailAccess')

export function useMailAccess(): MailAccess {
  const access = inject(mailAccessKey)
  if (!access) throw new Error('邮箱接口未装配')
  return access
}
