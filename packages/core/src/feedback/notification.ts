import { normalizeThemePalette, themePaletteColor } from '../preferences/palette.js'
import { readPreferenceDocument } from '../preferences/general.js'
import type { PreferenceDocumentStore } from '../preferences/service.js'
import type { FeedbackNotice } from './submission.js'

export interface FeedbackNotificationSettings {
  readonly fromAddress: string
  readonly user: string
  readonly toAddress: string
  readonly feedbackEnabled: boolean
}
export interface FeedbackMail {
  from: { name: string; address: string }
  to: string
  subject: string
  text: string
  html: string
}
export interface FeedbackMailTransport { sendMail(message: FeedbackMail): Promise<unknown> }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

/** 在反馈提交后读取偏好，返回可在响应后执行的邮件任务。 */
export function createFeedbackNotifier(
  preferences: Pick<PreferenceDocumentStore, 'read'>,
  settings: FeedbackNotificationSettings,
  transport: FeedbackMailTransport | null,
) {
  return async (notice: FeedbackNotice): Promise<() => Promise<void>> => {
    const data = readPreferenceDocument(await preferences.read(notice.ownerId))
    const dark = data.theme === 'dark'
    const palette = normalizeThemePalette(data.palette)
    return async () => {
      if (!settings.feedbackEnabled || !settings.toAddress || !transport) return
      const label = ({ bug: 'Bug 反馈', suggestion: '功能建议', other: '其他' } as Record<string, string>)[notice.category] ?? notice.category
      const subject = `[咕咕反馈] ${label} · ${notice.username}`
      const text = `用户：${notice.username}\n分类：${label}\n\n${notice.content}`
      const brand = themePaletteColor(palette, dark ? 'dark' : 'light')
      const html = `<div style="background:${dark ? '#171925' : '#f3f4f8'};color:${dark ? '#f3f4f8' : '#20222b'};padding:24px;font-family:sans-serif"><h1 style="color:${brand}">${escapeHtml(subject)}</h1><p style="white-space:pre-wrap">${escapeHtml(text)}</p></div>`
      await transport.sendMail({ from: { name: '咕咕', address: settings.fromAddress.includes('@') ? settings.fromAddress : settings.user }, to: settings.toAddress, subject, text, html })
    }
  }
}
