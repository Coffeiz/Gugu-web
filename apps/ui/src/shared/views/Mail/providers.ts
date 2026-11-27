import { mailPresets, type MailAccountSummary } from '@gugu/email/contracts'
import qq from './icons/qq.png'
import tencentExmail from './icons/tencent-exmail.png'
import netease from './icons/netease.png'
import icloud from './icons/icloud.png'
import gmail from './icons/gmail.png'
import outlook from './icons/outlook.png'

export type MailProvider = keyof typeof mailPresets | 'other'

// 品牌图标来自各服务商官网。网易三个邮箱入口使用同一个官网图标。
export const mailProviders = [
  { id: 'outlook', label: 'Outlook / Microsoft 365', icon: outlook, domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'] },
  { id: 'gmail', label: 'Gmail', icon: gmail, domains: ['gmail.com', 'googlemail.com'] },
  { id: 'qq', label: 'QQ 邮箱', icon: qq, domains: ['qq.com', 'foxmail.com'] },
  { id: 'tencentExmail', label: '腾讯企业邮箱', icon: tencentExmail, domains: [] },
  { id: '163', label: '网易 163 邮箱', icon: netease, domains: ['163.com'] },
  { id: '126', label: '网易 126 邮箱', icon: netease, domains: ['126.com'] },
  { id: 'yeah', label: '网易 Yeah 邮箱', icon: netease, domains: ['yeah.net'] },
  { id: 'icloud', label: 'iCloud 邮箱', icon: icloud, domains: ['icloud.com', 'me.com', 'mac.com'] },
  { id: 'other', label: '其他邮箱', icon: null, domains: [] },
] satisfies { id: MailProvider; label: string; icon: string | null; domains: string[] }[]

export function mailProviderForAccount(account: Pick<MailAccountSummary, 'email' | 'imapHost' | 'oauthProvider'>) {
  const host = account.imapHost.toLowerCase()
  const domain = account.email.split('@').at(-1)?.toLowerCase() ?? ''
  return mailProviders.find(({ id }) => id === account.oauthProvider)
    ?? mailProviders.find(({ id }) => id !== 'other' && mailPresets[id].imapHost === host)
    ?? mailProviders.find(({ domains }) => domains.includes(domain))
    ?? mailProviders.at(-1)!
}
