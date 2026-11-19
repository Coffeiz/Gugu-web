import nodemailer, { type Transporter } from 'nodemailer'

export interface SmtpEmailSettings {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly fromAddress: string
  readonly enabled: boolean
  readonly useSsl: boolean
}

export interface AuthEmailSender {
  sendResetEmail(input: { to: string; username: string; link: string }): Promise<boolean>
  sendRegistrationVerification(input: { to: string; code: string }): Promise<boolean>
  sendEmailChangeVerification(input: { to: string; username: string; link: string }): Promise<boolean>
  sendEmailChangeNotice(input: { to: string; username: string; kind: 'requested' | 'completed' }): Promise<boolean>
}

export interface UserSmtpTestEmailInput {
  host: string
  port: number
  user: string
  password: string
  fromAddr: string
  toAddr: string
  useSsl: boolean
  template: string
  theme: string
  palette: string
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function senderAddress(settings: SmtpEmailSettings): string {
  return settings.fromAddress.includes('@') ? settings.fromAddress : settings.user
}

export function createSmtpTransport(
  settings: SmtpEmailSettings,
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport,
): Transporter | null {
  if (!settings.enabled || !settings.host || !settings.user || !settings.password || !senderAddress(settings))
    return null
  return createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.useSsl,
    requireTLS: !settings.useSsl,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })
}

export function createAuthEmailSender(
  settings: SmtpEmailSettings,
  transport: Pick<Transporter, 'sendMail'> | null = createSmtpTransport(settings),
): AuthEmailSender | undefined {
  if (!transport) return undefined
  const from = { name: '咕咕', address: senderAddress(settings) }
  return {
    async sendResetEmail({ to, username, link }) {
      let safeLink: URL
      try {
        safeLink = new URL(link)
      } catch {
        return false
      }
      if (!['http:', 'https:'].includes(safeLink.protocol)) return false
      const subject = '咕咕 · 重置密码'
      const text = `你正在重置咕咕账号「${username}」的密码。\n\n点击下面的链接设置新密码（30 分钟内有效）：\n${safeLink.href}\n\n如果这不是你本人操作，忽略此邮件即可，密码不会变动。`
      const html = `<p>你正在重置咕咕账号「${escapeHtml(username)}」的密码。</p><p>点击下面的按钮设置新密码，链接 30 分钟内有效。</p><p><a href="${escapeHtml(safeLink.href)}">重置密码</a></p><p>如果这不是你本人操作，忽略此邮件即可，密码不会变动。</p>`
      try {
        await transport.sendMail({ from, to, subject, text, html })
        return true
      } catch {
        return false
      }
    },
    async sendRegistrationVerification({ to, code }) {
      if (!/^\d{6}$/.test(code)) return false
      const subject = '咕咕 · 注册验证码'
      const text = `你的咕咕注册验证码是：${code}\n\n验证码 10 分钟内有效，请勿向他人透露。`
      const html = `<p>你的咕咕注册验证码是：</p><p><strong>${code}</strong></p><p>验证码 10 分钟内有效，请勿向他人透露。</p>`
      try {
        await transport.sendMail({ from, to, subject, text, html })
        return true
      } catch {
        return false
      }
    },
    async sendEmailChangeVerification({ to, username, link }) {
      let safeLink: URL
      try {
        safeLink = new URL(link)
      } catch {
        return false
      }
      if (!['http:', 'https:'].includes(safeLink.protocol)) return false
      const subject = '咕咕 · 确认新邮箱'
      const safeUsername = escapeHtml(username)
      const text = `你正在为咕咕账号「${username}」设置新的登录邮箱。\n\n点击下面的链接确认邮箱（30 分钟内有效）：\n${safeLink.href}\n\n如果这不是你本人操作，请忽略此邮件。`
      const html = `<p>你正在为咕咕账号「${safeUsername}」设置新的登录邮箱。</p><p>确认后，新邮箱将用于登录、找回密码和账户安全通知。链接 30 分钟内有效。</p><p><a href="${escapeHtml(safeLink.href)}">确认新邮箱</a></p><p>如果这不是你本人操作，请忽略此邮件。</p>`
      try {
        await transport.sendMail({ from, to, subject, text, html })
        return true
      } catch {
        return false
      }
    },
    async sendEmailChangeNotice({ to, username, kind }) {
      const requested = kind === 'requested'
      const subject = requested ? '咕咕 · 邮箱变更申请提醒' : '咕咕 · 邮箱已变更'
      const text = requested
        ? `咕咕账号「${username}」刚刚发起了邮箱变更申请。\n\n如果这不是你本人操作，请尽快登录并修改密码。`
        : `咕咕账号「${username}」的登录邮箱已完成变更。\n\n如果这不是你本人操作，请尽快使用新邮箱登录并修改密码。`
      const html = requested
        ? `<p>咕咕账号「${escapeHtml(username)}」刚刚发起了邮箱变更申请。</p><p>如果这不是你本人操作，请尽快登录并修改密码。</p>`
        : `<p>咕咕账号「${escapeHtml(username)}」的登录邮箱已完成变更。</p><p>如果这不是你本人操作，请尽快使用新邮箱登录并修改密码。</p>`
      try {
        await transport.sendMail({ from, to, subject, text, html })
        return true
      } catch {
        return false
      }
    },
  }
}

/** Sends a user-requested SMTP smoke message; transport errors are returned to the route as a generic failure. */
export async function sendUserSmtpTestEmail(
  input: UserSmtpTestEmailInput,
  createTransport: (settings: SmtpEmailSettings) => Pick<Transporter, 'sendMail'> | null = (settings) => createSmtpTransport(settings),
): Promise<void> {
  const settings: SmtpEmailSettings = {
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    fromAddress: input.fromAddr || input.user,
    enabled: true,
    useSsl: input.useSsl,
  }
  const transport = createTransport(settings)
  if (!transport) throw new Error('SMTP transport is unavailable')
  const from = { name: '咕咕', address: senderAddress(settings) }
  const subject = '咕咕 · 邮件样式测试'
  const text = '这是来自咕咕开发页面的邮件样式测试，收到即表示 SMTP 配置和邮件模板均可用。'
  const html = `<div style="font-family:sans-serif"><h1>邮件样式测试</h1><p>${escapeHtml(text)}</p><p>模板：${escapeHtml(input.template)}；主题：${escapeHtml(input.theme)}；配色：${escapeHtml(input.palette)}</p></div>`
  await transport.sendMail({ from, to: input.toAddr, subject, text, html })
}
