import { parseSmtpSettings, type SmtpSettings } from '@gugu/core/smtp'
import { testSmtp, type SmtpTestDelivery } from '@gugu/core/email/smtp-test'
import { createSmtpTestDelivery } from '@gugu/core/email/smtp-delivery'
import { createEncryptedDesktopStore } from '../auth/store.js'
import { DesktopError } from '../core-host.js'

export const personalSmtpId = '00000000-0000-4000-8000-000000000001'

export function createDesktopPersonalSmtp(
  directory: string,
  encryption: Parameters<typeof createEncryptedDesktopStore>[2],
  defaultRecipient: () => Promise<string>,
  deliver = createSmtpTestDelivery(process.env, true),
) {
  const store = createEncryptedDesktopStore(directory, 'personal-smtp', encryption, value => {
    const { settings, password } = parseSmtpSettings(value)
    return { ...settings, password: password ?? '' }
  })
  function summary(value: SmtpSettings) {
    const { host, port, user, fromAddr, useSsl, enabled } = value
    return { host, port, user, fromAddr, useSsl, enabled, configured: true }
  }
  let pending: Promise<unknown> = Promise.resolve()
  async function get() {
    const item = await store.read()
    return item ? summary(item) : null
  }
  return {
    read: store.read,
    async command(action: unknown, value?: unknown) {
      if (action === 'get') return get()
      if (action !== 'save' && action !== 'test') throw new DesktopError('invalid_request', 'SMTP 操作无效')
      const { settings, password } = parseSmtpSettings(value)
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(settings.host)
        || /[\r\n\0]/u.test(settings.user + settings.fromAddr)) throw new DesktopError('invalid_request', 'SMTP 配置无效')
      const address = (value as { toAddr?: unknown }).toAddr
      const matches = (previous: SmtpSettings | null) => previous?.host.toLowerCase() === settings.host.toLowerCase()
        && previous.port === settings.port && previous.user === settings.user && previous.useSsl === settings.useSsl
      if (action === 'save') {
        const result = pending.then(async () => {
          const previous = await store.read()
          if (previous?.password && password === null && !matches(previous))
            throw new DesktopError('invalid_request', '更换 SMTP 服务器或账号时请重新填写密码')
          await store.write({ ...settings, password: password ?? previous?.password ?? '' })
          return summary(settings)
        })
        pending = result.catch(() => {})
        return result
      }
      if (address !== undefined && (typeof address !== 'string' || !/^[^\s@,;<>]+@[^\s@,;<>]+$/u.test(address) || address.length > 254))
        throw new DesktopError('invalid_request', '测试收件人地址无效')
      const previous = await store.read()
      const savedPassword = matches(previous) ? previous?.password : ''
      return testSmtp({ host: settings.host, port: settings.port, user: settings.user, password: password || savedPassword,
        from_addr: settings.fromAddr, to_addr: typeof address === 'string' ? address : await defaultRecipient(), use_ssl: settings.useSsl },
      { host: '', port: 587, user: '', password: '', from_addr: '', to_addr: '', test_to_addr: '' }, deliver)
    },
    deliver: (delivery: SmtpTestDelivery, signal?: AbortSignal) => deliver(delivery, signal),
  }
}
