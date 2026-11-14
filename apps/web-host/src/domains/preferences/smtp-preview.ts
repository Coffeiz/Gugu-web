import { CoreError } from '@gugu/core'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export type SmtpPreviewTemplate = 'notification' | 'reminder' | 'report' | 'security' | 'test'
export type SmtpPreviewTheme = 'light' | 'dark'
export type SmtpPreviewPalette = 'cafe' | 'neutral' | 'red' | 'blue' | 'green'

const templates = new Set<SmtpPreviewTemplate>(['notification', 'reminder', 'report', 'security', 'test'])
const themes = new Set<SmtpPreviewTheme>(['light', 'dark'])
const palettes: Record<SmtpPreviewPalette, { light: string; dark: string }> = {
  cafe: { light: '#715653', dark: '#be9d98' },
  neutral: { light: '#565b64', dark: '#c0c3c9' },
  red: { light: '#a66e73', dark: '#d0a1a4' },
  blue: { light: '#65789a', dark: '#9aaecd' },
  green: { light: '#718a7e', dark: '#a9c2b5' },
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function previewInput(value: unknown): { template: SmtpPreviewTemplate; theme: SmtpPreviewTheme; palette: SmtpPreviewPalette } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('invalid_request', '请求体无效')
  const body = value as Record<string, unknown>
  const template = body.template === undefined ? 'notification' : body.template
  const theme = body.theme === undefined ? 'light' : body.theme
  const palette = body.palette === undefined ? 'neutral' : body.palette
  if (typeof template !== 'string' || !templates.has(template as SmtpPreviewTemplate))
    throw new CoreError('invalid_request', 'template 无效')
  if (typeof theme !== 'string' || !themes.has(theme as SmtpPreviewTheme))
    throw new CoreError('invalid_request', 'theme 无效')
  if (typeof palette !== 'string' || !Object.hasOwn(palettes, palette))
    throw new CoreError('invalid_request', 'palette 无效')
  return {
    template: template as SmtpPreviewTemplate,
    theme: theme as SmtpPreviewTheme,
    palette: palette as SmtpPreviewPalette,
  }
}

export function renderUserSmtpPreview(value: unknown): { html: string } {
  const { template, theme, palette } = previewInput(value)
  const dark = theme === 'dark'
  const colors = {
    canvas: dark ? '#171925' : '#f3f4f8',
    surface: dark ? '#232638' : '#ffffff',
    brand: palettes[palette][dark ? 'dark' : 'light'],
    text: dark ? '#f3f4f8' : '#20222b',
    muted: dark ? '#b7bbca' : '#6f7486',
    border: dark ? '#41465c' : '#dfe2eb',
  }
  const heading = escapeHtml('邮件样式测试')
  const preheader = escapeHtml('咕咕为你整理了一封结构清晰的邮件')
  const body = escapeHtml('这是来自咕咕开发页面的邮件样式测试，收到即表示 SMTP 配置和邮件模板均可用。')
  const sectionHeading = escapeHtml('模板预览')
  const sectionText = escapeHtml(`当前模板：${template}`)
  const scrollbar = dark
    ? `<style>html{color-scheme:dark}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:${colors.canvas}}::-webkit-scrollbar-thumb{background:${colors.border};border-radius:5px}</style>`
    : ''
  const logo = `
    <div style="text-align:center;padding:0 0 24px;margin:0;border-bottom:1px solid ${colors.border}">
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
        <td valign="middle" style="width:92px">
          <div role="img" aria-label="咕咕" style="width:96px;height:96px;background:${colors.brand};-webkit-mask:url('/logo-large2.png') center/contain no-repeat;mask:url('/logo-large2.png') center/contain no-repeat"></div>
        </td>
        <td valign="middle" width="190" style="width:190px;text-align:center">
          <div role="img" aria-label="咕咕" style="width:190px;height:90px;background:${colors.brand};-webkit-mask:url('/logo-text2.png') center/contain no-repeat;mask:url('/logo-text2.png') center/contain no-repeat;margin:0 auto"></div>
          <div style="width:190px;margin:0 auto;padding:2px 0 0;text-align:center;color:${colors.muted};font-size:10px;letter-spacing:.08em">${escapeHtml(template.toUpperCase())}</div>
        </td>
      </tr></table>
    </div>`
  const html = `<!doctype html>
    <html><head>${scrollbar}</head>
    <body style="margin:0;background:${colors.canvas};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${colors.text};color-scheme:${dark ? 'dark' : 'light'}">
      <div style="display:none;max-height:0;overflow:hidden">${preheader}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${colors.canvas};padding:28px 12px"><tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;background:${colors.surface};border:1px solid ${colors.border};border-radius:14px"><tr><td style="padding:40px">
          ${logo}
          <div style="height:20px;line-height:20px;font-size:1px">&nbsp;</div>
          <h1 style="margin:0;color:${colors.text};font-size:24px;line-height:1.35">${heading}</h1>
          <div style="height:8px;line-height:8px;font-size:1px">&nbsp;</div>
          <p style="margin:0;color:${colors.muted};font-size:13px">${preheader}</p>
          <div style="height:24px;line-height:24px;font-size:1px">&nbsp;</div>
          <div style="color:${colors.text};font-size:15px;line-height:1.75">${body}</div>
          <div style="height:22px;line-height:22px;font-size:1px">&nbsp;</div>
          <div style="padding:17px;border-left:3px solid ${colors.brand};border-radius:0 8px 8px 0;background:${colors.canvas};color:${colors.muted};font-size:14px;line-height:1.7">
            <strong style="display:block;margin-bottom:6px;color:${colors.text};font-size:13px">${sectionHeading}</strong>${sectionText}
          </div>
          <p style="margin:28px 0 0;padding:16px 0 0;border-top:1px solid ${colors.border};color:${colors.muted};font-size:12px">由咕咕发送 · SMTP 已接受不代表最终送达</p>
        </td></tr></table>
      </td></tr></table>
    </body></html>`
  return { html }
}

export function registerUserSmtpPreviewRoute(app: FastifyInstance, requireUser: preHandlerHookHandler): void {
  app.post('/api/v1/preferences/smtp/preview', { preHandler: requireUser }, async (request) =>
    renderUserSmtpPreview(request.body))
}
