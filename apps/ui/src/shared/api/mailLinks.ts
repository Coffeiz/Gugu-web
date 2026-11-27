import type { InjectionKey } from 'vue'
import { mailDraftLocation, type MailDraftLocation } from '@gugu/email/contracts'
import type { Router } from 'vue-router'

export function isMailRecipient(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s<>,;@/?#]+@[^\s<>,;@/?#]+\.[^\s<>,;@/?#]+$/u.test(value)
}

export function openMailComposer(router: Router, recipient: string) {
  return router.push({ name: 'mail', query: { composeTo: recipient } })
}

export function installMailLinks(open: (recipient: string) => unknown) {
  document.addEventListener('click', event => {
    if (event.defaultPrevented) return
    const recipient = mailRecipientFromClick(event)
    if (!recipient) return
    event.preventDefault()
    void open(recipient)
  }, true)
}

export function mailRecipientFromClick(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest('a[href^="mailto:" i]') : null
  if (link?.hasAttribute('data-system-contact-link')) return
  const href = link?.getAttribute('href')
  if (!href) return
  try {
    const recipient = decodeURIComponent(href.slice(7).split('?')[0]!)
    if (isMailRecipient(recipient)) return recipient
  } catch { /* 无效的 URL 编码。 */ }
}

export const openMailDraftKey: InjectionKey<(draft: MailDraftLocation) => void> = Symbol('openMailDraft')

export function openMailDraft(router: Router, draft: MailDraftLocation) {
  return router.push({ name: 'mail', query: {
    draftAccount: draft.accountId, draftMailbox: draft.mailbox,
    draftUid: draft.uid == null ? undefined : String(draft.uid), draftValidity: draft.validity,
  } })
}

export function readMailDraftLocation(value: unknown): MailDraftLocation | null {
  if (typeof value !== 'string' || value.length > 1024) return null
  try {
    const result = mailDraftLocation.safeParse(JSON.parse(value))
    return result.success ? result.data : null
  } catch { return null }
}
