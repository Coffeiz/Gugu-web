import { sanitizeChatHtml } from '@/utils/markdown'

type Snapshot = { html: string; label: string }
const storageKey = 'gugu_chat_card_snapshots_v1'

export function stripChatCardSnapshotMarkers(html: string) {
  if (!/data-chat-card-loaded/i.test(html)) return html
  const template = document.createElement('template')
  template.innerHTML = sanitizeChatHtml(html)
  template.content.querySelectorAll('[data-chat-card-loaded]').forEach(element => element.removeAttribute('data-chat-card-loaded'))
  return template.innerHTML
}

/** 只保存已成功读取的展示内容，按账号、消息和引用隔离。 */
export function applyChatCardSnapshots(html: string, scope: string, label: string) {
  if (!scope || !html.includes('chat-object-card')) return html
  let entries: Record<string, Snapshot>
  try { entries = JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {} }
  catch { return html }
  const root = document.createElement('div')
  root.innerHTML = sanitizeChatHtml(html)
  let changed = false
  for (const card of root.querySelectorAll<HTMLAnchorElement>('a.chat-object-card[href^="gugu://"]')) {
    const key = JSON.stringify([scope, card.getAttribute('href')])
    if (card.hasAttribute('data-chat-card-loaded')) {
      const copy = card.cloneNode(true) as HTMLAnchorElement
      copy.querySelectorAll('img, .chat-object-card-loading').forEach(element => element.remove())
      const snapshot = { html: copy.innerHTML, label: card.getAttribute('aria-label') ?? '' }
      if (snapshot.html.length <= 10_000 && (entries[key]?.html !== snapshot.html || entries[key]?.label !== snapshot.label)) {
        delete entries[key]
        entries[key] = snapshot
        changed = true
      }
    } else if (!card.querySelector('.chat-object-card-loading:not(.is-image-only)')) {
      const snapshot = entries[key]
      if (typeof snapshot?.html !== 'string' || typeof snapshot.label !== 'string') continue
      card.innerHTML = sanitizeChatHtml(snapshot.html)
      card.removeAttribute('href')
      card.classList.add('is-snapshot')
      const status = document.createElement('span')
      status.className = 'chat-object-card-snapshot'
      status.textContent = label
      card.setAttribute('aria-label', `${snapshot.label} · ${label}`)
      card.append(status)
    }
  }
  if (changed) {
    try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(entries).slice(-240)))) }
    catch { /* 浏览器存储不可用时继续展示实时卡片。 */ }
  }
  return root.innerHTML
}
