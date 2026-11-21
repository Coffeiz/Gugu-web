import type { MailAccess } from '@/api/mail'
import { post } from '@/api/client'

export const webMailAccess: MailAccess = {
  preview: false,
  request: command => post('/mail/command', command),
}
