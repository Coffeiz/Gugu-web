import type { MailAccess } from '@/api/mail'
import { post } from '@/api/client'

export const webMailAccess: MailAccess = {
  request: command => post('/mail/command', command),
}
