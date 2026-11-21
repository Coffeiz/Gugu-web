import { inject, type InjectionKey } from 'vue'
import type { MailCommand } from '@gugu/core/mail/contracts'

export interface MailAccess {
  readonly preview: boolean
  request<T>(command: MailCommand): Promise<T>
}

export const mailAccessKey: InjectionKey<MailAccess> = Symbol('mailAccess')

export function useMailAccess(): MailAccess {
  const access = inject(mailAccessKey)
  if (!access) throw new Error('邮箱接口未装配')
  return access
}
