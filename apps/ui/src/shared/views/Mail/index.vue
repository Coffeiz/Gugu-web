<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { mailCommand, type MailAccountSummary, type MailAttachment, type MailCommand, type MailDraft, type MailFolder, type MailInbox, type MailLocatedMessage, type MailMessage, type MailPage, type MailRead } from '@gugu/email/contracts'
import { PhArrowClockwise, PhCaretLeft, PhPlus, PhPencilSimpleLine, PhArchive, PhTrash, PhFolder, PhImage, PhPaperPlaneTilt, PhFloppyDisk, PhX, PhLink, PhLinkBreak, PhDownloadSimple, PhCaretDown, PhCheck, PhPaperclip } from '@phosphor-icons/vue'
import { RiInboxLine, RiMailOpenLine, RiMailUnreadLine, RiReplyLine, RiShareForwardFill } from '@remixicon/vue'
import SkeletonGate from '@/components/common/feedback/skeleton/SkeletonGate.vue'
import SkeletonBlock from '@/components/common/feedback/skeleton/SkeletonBlock.vue'
import RefreshButton from '@/components/common/controls/RefreshButton.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FirstUseEmptyState from '@/components/common/layout/FirstUseEmptyState.vue'
import SearchInput from '@/components/common/controls/SearchInput.vue'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { useRoute, useRouter } from 'vue-router'
import { isMailRecipient } from '@/api/mailLinks'
import { useMailAccess } from '@/api/mail'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { errorMessage, showAppError, showAppSuccess } from '@/composables/core/useAppToast'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import MailMessageEditor from './MailMessageEditor.vue'
import { renderMarkdown, sanitizeHtml } from '@/utils/markdown'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { clearMailViewCache, getMailFolders, getMailList, getReadMail, rememberMailFolders, rememberMailList, rememberMailSeen, rememberReadMail } from './mailViewCache'
import { splitName } from '@/utils/fileParse'
import { fileListIcon } from '@/utils/fileTypes'
import MailMessageHeading from './MailMessageHeading.vue'
import MailAccountForm from './MailAccountForm.vue'
import MailProviderIcon from './MailProviderIcon.vue'
import { mailProviderForAccount } from './providers'
import { useMailInboxStatus } from './useMailInboxStatus'

const { t, locale } = useI18n()

const pathFilesApi = usePathFileAccess()

const { request: requestMail } = useMailAccess()
const { accounts: cachedAccounts, unreadCounts, unreadTotal, lastChange, refreshAccounts, refreshInboxCount } = useMailInboxStatus()
const accounts = ref<MailAccountSummary[]>([])
const accountId = ref('')
const aggregate = ref<MailInbox>()
const activeMessage = ref<MailLocatedMessage>()
const reading = computed(() => Boolean(activeMessage.value && !selected.value && !error.value))
const loadingImages = ref(false)
const pendingSeen = reactive(new Set<string>())
const updatingSeen = computed(() => Boolean(activeMessage.value && pendingSeen.has(rowKey(activeMessage.value))))
const hasRemoteImages = computed(() => /\sdata-mail-(?:image|background)="/i.test(selected.value?.html ?? ''))
const readingHtml = computed(() => {
  const html = selected.value?.html
  if (!html) return ''
  const body = document.createElement('template')
  body.innerHTML = sanitizeHtml(html)
  for (const image of body.content.querySelectorAll('img')) {
    if (!/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(image.getAttribute('src') ?? '')) image.remove()
  }
  for (const link of body.content.querySelectorAll('[href]')) {
    const href = link.getAttribute('href') ?? ''
    const url = /^https?:\/\//i.test(href) && !/[\p{Cc}\p{Cf}]/u.test(href) ? URL.parse(href) : null
    link.removeAttribute('ping')
    if (link.tagName !== 'A' || !url || url.username || url.password) {
      link.removeAttribute('href')
      continue
    }
    link.setAttribute('href', url.href)
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
    link.removeAttribute('download')
  }
  // 正文保持无脚本隔离。只有用户点击的 HTTP(S) 链接在新标签打开。
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light"><style>html{color-scheme:light;color:#1c1e21;background:white}body{box-sizing:border-box;margin:0;padding:var(--space-md) var(--space-lg);font:14px/1.6 system-ui;overflow-wrap:anywhere}table{max-width:100%!important;margin-inline:auto!important}td,th,div,img{box-sizing:border-box;min-width:0!important;max-width:100%!important}img{height:auto}pre{white-space:pre-wrap}</style></head><body>${body.innerHTML}</body></html>`
})
const accountById = computed(() => new Map(accounts.value.map(item => [item.id, item])))
const accountLabels = computed(() => new Map(accounts.value.map(item => [item.id, item.displayName || item.email])))
const senders = computed(() => accounts.value.filter(item => !item.receiveOnly))
const defaultSenderId = ref('')
const isAggregate = computed(() => !accountId.value)
const unreadOnly = ref(false)
const visibleMessages = computed(() => unreadOnly.value
  ? aggregate.value?.items.filter(item => !item.seen)
  : isAggregate.value ? aggregate.value?.items : messages.value?.items)
const unavailableAccounts = computed(() => aggregate.value?.unavailableAccountIds.map(id => accountLabels.value.get(id)).filter(Boolean) ?? [])
const compactPane = ref<'list' | 'reading'>('list')
const folders = ref<MailFolder[]>([])
const folder = ref('')
const currentFolder = computed(() => folders.value.find(item => item.path === folder.value))
const account = computed(() => accounts.value.find(item => item.id === accountId.value))
const query = ref('')
const appliedQuery = ref('')
const messages = ref<MailPage>()
const selected = ref<MailRead>()
const error = ref('')
const busy = ref(false)
const loading = ref(true)
const loadingMore = ref(false)
const paginationError = ref('')
const refreshError = ref('')
const nextPage = computed(() => {
  if (!isAggregate.value) return messages.value?.next ?? null
  const cursors = aggregate.value?.next
  return cursors && Object.keys(cursors).length ? cursors : null
})
let lastRequestedCursor: string | undefined
const accountForm = ref<'add' | MailAccountSummary>()
type MessageRef = { mailbox: string; uid: number; validity: string }
const compose = ref<{ to: string; subject: string; text: string; attemptId: string; senderId: string; replace?: MessageRef; replyTo?: MessageRef }>()
let initialCompose: typeof compose.value
const sendUnconfirmed = ref(false)
let requestVersion = 0
let readVersion = 0

function folderLabel(value: MailFolder) {
  return ({ '\\Inbox': t('pageUi.inbox'), '\\Drafts': t('pageUi.drafts'), '\\Sent': t('pageUi.sentMail'), '\\Trash': t('pageUi.trash'), '\\Junk': t('pageUi.junk'), '\\Archive': t('pageUi.archive') } as Record<string, string>)[value.specialUse ?? ''] ?? (/^junk$/i.test(value.name) ? t('pageUi.junk') : value.name)
}

const mailListKey = () => JSON.stringify([accounts.value.map(item => item.id).sort(), accountId.value, folder.value, unreadOnly.value, appliedQuery.value])
const hasList = computed(() => isAggregate.value ? aggregate.value !== undefined : messages.value !== undefined)
const updatingList = computed(() => loading.value && !loadingMore.value && hasList.value)

async function loadAccounts(preferred = accountId.value, restoreInbox = false) {
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  refreshError.value = ''
  if (restoreInbox) {
    accounts.value = cachedAccounts.value
    const cached = getMailList(mailListKey())
    if (cached && 'unavailableAccountIds' in cached) aggregate.value = cached
  }
  const cachedKey = mailListKey()
  try {
    const refreshed = await refreshAccounts()
    if (version !== requestVersion) return
    accounts.value = refreshed
    try { defaultSenderId.value = localStorage.getItem('gugu.mail.defaultSender') ?? '' } catch { defaultSenderId.value = '' }
    if (restoreInbox && aggregate.value && cachedKey === mailListKey()) {
      await loadMessages(undefined, false, true)
    } else {
      await chooseAccount(refreshed.find(item => item.id === preferred)?.id ?? '')
    }
  } catch (cause) {
    if (version === requestVersion) (hasList.value ? refreshError : error).value = errorMessage(cause)
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

async function chooseAccount(id: string, unread = false) {
  unreadOnly.value = unread
  requestVersion++
  loadingMore.value = false
  paginationError.value = ''
  refreshError.value = ''
  lastRequestedCursor = undefined
  readVersion++
  accountId.value = id
  folders.value = []
  folder.value = ''
  messages.value = undefined
  aggregate.value = undefined
  activeMessage.value = undefined
  selected.value = undefined
  compactPane.value = 'list'
  compose.value = undefined
  query.value = ''
  appliedQuery.value = ''
  error.value = ''
  if (!id) { await loadMessages(); return }
  const cachedFolders = getMailFolders(id)
  const inboxOf = (items: MailFolder[]) => items.find(item => item.specialUse === '\\Inbox') ?? items[0]
  const version = requestVersion
  loading.value = true
  try {
    const result = cachedFolders ?? await requestMail<MailFolder[]>({ action: 'folders', accountId: id })
    if (version !== requestVersion) return
    if (!cachedFolders) rememberMailFolders(id, result)
    folders.value = result
    const next = inboxOf(result)
    if (next) await chooseFolder(next.path)
  } catch (cause) {
    if (version === requestVersion) error.value = errorMessage(cause)
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

async function refreshMailbox() {
  const id = accountId.value
  if (!id) { await loadMessages(undefined, false, true); return }
  const version = ++requestVersion
  loading.value = true
  refreshError.value = ''
  try {
    const result = await requestMail<MailFolder[]>({ action: 'folders', accountId: id })
    if (version !== requestVersion) return
    rememberMailFolders(id, result)
    folders.value = result
    if (result.some(item => item.path === folder.value)) await loadMessages(undefined, false, true)
    else await chooseAccount(id)
  } catch (cause) {
    if (version === requestVersion) refreshError.value = errorMessage(cause)
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

async function chooseFolder(path: string) {
  folder.value = path
  query.value = ''
  appliedQuery.value = ''
  await loadMessages()
}

async function loadMessages(before?: number, moreInbox = false, background = false) {
  if (!accounts.value.length || (!isAggregate.value && !folder.value)) { loading.value = false; return }
  const append = before !== undefined || moreInbox
  const version = ++requestVersion
  loading.value = true
  loadingMore.value = append
  paginationError.value = ''
  refreshError.value = ''
  if (!append && !background) {
    lastRequestedCursor = undefined
    error.value = ''
  }
  const listKey = mailListKey()
  if (!append && !background) {
    readVersion++
    const cached = getMailList(listKey)
    aggregate.value = cached && 'unavailableAccountIds' in cached ? cached : undefined
    messages.value = cached && 'validity' in cached ? cached : undefined
    selected.value = undefined
    activeMessage.value = undefined
    compactPane.value = 'list'
  }
  try {
    if (isAggregate.value) {
      const previous = moreInbox || (background && !unreadOnly.value) ? aggregate.value : undefined
      const result = await requestMail<MailInbox>({ action: 'inbox', unreadOnly: unreadOnly.value || undefined, query: appliedQuery.value, before: moreInbox ? previous?.next : undefined })
      if (version === requestVersion) {
        if (previous) {
          const validity = new Map(result.items.map(item => [item.accountId, item.validity]))
          const oldest = new Map<string, number>()
          for (const item of result.items)
            oldest.set(item.accountId, Math.min(oldest.get(item.accountId) ?? item.uid, item.uid))
          const unavailable = new Set(result.unavailableAccountIds)
          const previousKeys = new Set(previous.items.map(rowKey))
          const overlappingAccounts = new Set(result.items.filter(item => previousKeys.has(rowKey(item))).map(item => item.accountId))
          const retained = previous.items.filter(item => {
            if (background && unavailable.has(item.accountId)) return true
            const currentValidity = validity.get(item.accountId)
            if (background) return overlappingAccounts.has(item.accountId) && currentValidity === item.validity
              && item.uid < (oldest.get(item.accountId) ?? 0)
            return currentValidity === undefined || currentValidity === item.validity
          })
          const items = new Map(retained.map(item => [rowKey(item), item]))
          if (background) {
            for (const item of retained) {
              if (unavailable.has(item.accountId) || item.uid < (result.next[item.accountId] ?? 0)) {
                const cursor = previous.next[item.accountId]
                if (cursor === undefined) delete result.next[item.accountId]
                else result.next[item.accountId] = cursor
              }
            }
          }
          for (const item of result.items) items.set(rowKey(item), item)
          result.items = [...items.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')
            || a.accountId.localeCompare(b.accountId) || b.uid - a.uid)
          if (!background) result.unavailableAccountIds = [...new Set([...previous.unavailableAccountIds, ...result.unavailableAccountIds])]
        }
        if (background && unreadOnly.value) lastRequestedCursor = undefined
        aggregate.value = result
        if (!moreInbox) rememberMailList(listKey, result)
      }
      return
    }
    const next = await requestMail<MailPage>({
      action: 'messages', accountId: accountId.value, mailbox: folder.value, query: appliedQuery.value, before,
    })
    if (version !== requestVersion) return
    const previous = messages.value
    if (before !== undefined && previous?.validity === next.validity) {
      messages.value = { ...next, items: [...previous.items, ...next.items.filter(item => !previous.items.some(known => known.uid === item.uid))] }
    } else if (background && next.next !== null && previous?.validity === next.validity
      && previous.items.some(item => item.uid === next.next)) {
      const cursor = next.next
      const older = previous.items.filter(item => item.uid < cursor)
      messages.value = older.length ? { ...next, items: [...next.items, ...older], next: previous.next } : next
    } else messages.value = next
    if (!append) rememberMailList(listKey, next)
  } catch (cause) {
    if (version === requestVersion) (append ? paginationError : hasList.value ? refreshError : error).value = errorMessage(cause)
  } finally {
    if (version === requestVersion) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function loadMore(automatic = false) {
  const cursor = nextPage.value
  if (loading.value || busy.value || cursor === null) return
  const key = typeof cursor === 'number' ? String(cursor) : JSON.stringify(Object.entries(cursor).sort())
  if (automatic && (paginationError.value || key === lastRequestedCursor)) return
  lastRequestedCursor = key
  void (typeof cursor === 'number' ? loadMessages(cursor) : loadMessages(undefined, true))
}

function onListScroll(event: Event) {
  const list = event.currentTarget
  if (list instanceof HTMLElement && list.scrollHeight - list.scrollTop - list.clientHeight <= 96)
    loadMore(true)
}

function located(item: MailMessage): MailLocatedMessage | undefined {
  if ('accountId' in item) return item as MailLocatedMessage
  if (messages.value) return { ...item, accountId: accountId.value, mailbox: folder.value, validity: messages.value.validity }
}

function rowKey(item: MailMessage) {
  const reference = located(item)
  return JSON.stringify([reference?.accountId, reference?.mailbox, reference?.validity, item.uid])
}

async function read(item: MailMessage) {
  const reference = located(item)
  if (!reference || busy.value) return
  const draft = compose.value
  if (draft && (draft.to !== initialCompose?.to || draft.subject !== initialCompose?.subject
    || draft.text !== initialCompose?.text || draft.senderId !== initialCompose?.senderId)) {
    const version = requestVersion
    if (!await confirmDialog({ title: t('pageUi.discardChangesTitle'), message: t('pageUi.switchDiscardHint'), confirmText: t('pageUi.discardChanges') })) return
    if (compose.value !== draft || busy.value || requestVersion !== version) return
  }
  compose.value = undefined
  const version = ++readVersion
  error.value = ''
  selected.value = undefined
  activeMessage.value = reference
  loadingImages.value = false
  compactPane.value = 'reading'
  const key = rowKey(item)
  const cached = getReadMail(key)
  try {
    const { accountId, mailbox, validity, uid } = reference
    const result = cached ?? await requestMail<MailRead>({ action: 'read', accountId, mailbox, validity, uid })
    if (version !== readVersion) return
    selected.value = { ...result, seen: item.seen || (!cached && result.seen) }
    rememberReadMail(key, selected.value)
    if (!selected.value.seen) void setMessageSeen(reference, true)
    else if (!item.seen) syncMessageSeen(reference, true)
  } catch (cause) { if (version === readVersion) error.value = errorMessage(cause) }
}

function syncMessageSeen(reference: MailLocatedMessage, seen: boolean) {
  const key = rowKey(reference)
  const row = visibleMessages.value?.find(message => rowKey(message) === key)
  if (row) row.seen = seen
  if (selected.value && activeMessage.value && rowKey(activeMessage.value) === key)
    selected.value.seen = seen
  rememberMailSeen(reference, seen)
  refreshInboxCount(reference.accountId)
}

async function setMessageSeen(reference: MailLocatedMessage, seen: boolean) {
  const key = rowKey(reference)
  if (pendingSeen.has(key)) return
  pendingSeen.add(key)
  const { accountId, mailbox, validity, uid } = reference
  try {
    await requestMail({ action: 'seen', accountId, mailbox, validity, uid, seen })
    syncMessageSeen(reference, seen)
  } catch (cause) {
    if (activeMessage.value && rowKey(activeMessage.value) === key)
      showAppError(t('pageUi.changeReadFailed', { reason: errorMessage(cause) }))
  } finally {
    pendingSeen.delete(key)
  }
}

async function loadRemoteImages() {
  const reference = activeMessage.value
  const message = selected.value
  if (!reference || !message || loadingImages.value) return
  loadingImages.value = true
  try {
    const { accountId, mailbox, validity, uid } = reference
    const result = await requestMail<MailRead>({ action: 'read', accountId, mailbox, validity, uid, remoteImages: true })
    if (activeMessage.value === reference) {
      selected.value = { ...result, seen: selected.value?.seen ?? message.seen }
      rememberReadMail(rowKey(reference), selected.value)
    }
  } catch (cause) { if (activeMessage.value === reference) error.value = errorMessage(cause) }
  finally { if (activeMessage.value === reference) loadingImages.value = false }
}

async function updateMessage(action: 'seen' | 'archive' | 'trash' | 'inbox') {
  if (!selected.value || !activeMessage.value || busy.value) return
  const item = selected.value
  const { accountId, mailbox, validity, uid } = activeMessage.value
  const ref = { accountId, mailbox, validity, uid }
  if (action === 'trash' && !await confirmDialog({ title: t('pageUi.moveToTrash'), message: item.subject || t('pageUi.noSubject') })) return
  if (selected.value !== item) return
  if (action === 'seen') {
    await setMessageSeen(activeMessage.value, !item.seen)
    return
  }
  await perform(async () => {
    await requestMail({ action: 'move', ...ref, target: action })
    await loadMessages()
  })
}

async function perform(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}

async function saveAttachment(index: number) {
  if (!selected.value || !activeMessage.value) return
  const { accountId, mailbox, validity, uid } = activeMessage.value
  const reference = { accountId, mailbox, validity, uid }
  await perform(async () => {
    const result = await requestMail<MailAttachment>({ action: 'attachment', ...reference, index })
    const data = Uint8Array.from(atob(result.data), char => char.charCodeAt(0))
    const file = new File([data], result.name)
    await pathFilesApi.upload({ directoryId: 'personal', relativePath: result.name }, file, () => {})
    showAppSuccess(t('pageUi.attachmentSaved'))
  })
}

async function disconnect(current: MailAccountSummary) {
  if (!await confirmDialog({ title: t('pageUi.disconnectMail'), message: t('pageUi.disconnectMailHint', { email: current.email }) })) return
  await perform(async () => {
    await requestMail({ action: 'disconnect', accountId: current.id })
    clearMailViewCache()
    await loadAccounts()
  })
}

function newAttemptId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function startCompose(mode?: 'reply' | 'forward' | 'draft', recipient = '') {
  const item = selected.value
  const ref = activeMessage.value
  const source = ref ? { mailbox: ref.mailbox, uid: ref.uid, validity: ref.validity } : undefined
  const originalSender = ref && senders.value.find(item => item.id === ref.accountId)
  const defaultSender = senders.value.find(item => item.id === accountId.value)
    ?? senders.value.find(item => item.id === defaultSenderId.value) ?? senders.value[0]
  const sender = mode === 'reply' || mode === 'draft' ? originalSender
    : mode === 'forward' ? originalSender || defaultSender : defaultSender
  if (!sender && !recipient) { error.value = t('pageUi.noOutgoing'); return }
  compactPane.value = 'reading'
  sendUnconfirmed.value = false
  compose.value = {
    to: mode === 'reply' ? item?.replyTo ?? '' : mode === 'draft' ? item?.to.join(', ') ?? '' : recipient,
    subject: mode === 'reply' ? `Re: ${item?.subject ?? ''}` : mode === 'forward' ? `Fwd: ${item?.subject ?? ''}` : mode === 'draft' ? item?.subject ?? '' : '',
    text: mode === 'draft' ? item?.text ?? '' : mode === 'forward' ? `\n\n${t('pageUi.forwardedMail')}\n${item?.text ?? ''}` : '',
    attemptId: newAttemptId(), senderId: sender?.id ?? '',
    replace: mode === 'draft' ? source : undefined,
    replyTo: mode === 'reply' ? source : undefined,
  }
  initialCompose = { ...compose.value }
}

async function submit(send: boolean) {
  const value = compose.value
  const sender = senders.value.find(item => item.id === value?.senderId)
  if (!value || !sender || busy.value) return
  const draft: MailDraft = { to: value.to.split(/[,，;；]/).map(item => item.trim()).filter(Boolean), subject: value.subject, text: value.text, ...(value.text.trim() ? { html: renderMarkdown(value.text) } : {}) }
  const command: MailCommand = send
    ? { action: 'send', accountId: sender.id, draft, attemptId: value.attemptId, replyTo: value.replyTo }
    : { action: 'draft', accountId: sender.id, draft, replace: value.replace }
  if (!mailCommand.safeParse(command).success) { error.value = t('pageUi.checkDraft'); return }
  if (send) {
    if (!draft.to.length) { error.value = t('pageUi.enterRecipient'); return }
    if (!await confirmDialog({ title: t('pageUi.confirmSend'), message: t('pageUi.sendDetails', { sender: sender.email, recipients: draft.to.join(', '), subject: draft.subject || t('pageUi.noSubject') }) })) return
    if (compose.value !== value || value.senderId !== sender.id || value.subject !== draft.subject || value.text !== draft.text
      || value.to.split(/[,，;；]/).map(item => item.trim()).filter(Boolean).join(',') !== draft.to.join(',')) return
  }
  await perform(async () => {
    if (send) {
      sendUnconfirmed.value = true
      const result = await requestMail<{ partial: boolean }>(command)
      showAppSuccess(result.partial ? t('pageUi.partialSend') : t('pageUi.mailSubmitted'))
    } else {
      await requestMail(command)
      showAppSuccess(t('pageUi.draftSaved'))
    }
    compose.value = undefined
    await loadMessages()
  })
}

function rememberSender() {
  if (!compose.value) return
  defaultSenderId.value = compose.value.senderId
  try { localStorage.setItem('gugu.mail.defaultSender', defaultSenderId.value) } catch { /* 当前窗口仍保留选择。 */ }
}

const changedInboxAccounts = new Set<string>()
let inboxRefresh: ReturnType<typeof setTimeout> | undefined
function refreshChangedInbox() {
  if (loading.value || busy.value || inboxRefresh || !changedInboxAccounts.size) return
  inboxRefresh = setTimeout(() => {
    inboxRefresh = undefined
    if (loading.value || busy.value) return
    const affected = isAggregate.value || (changedInboxAccounts.has(accountId.value)
      && (folder.value.toUpperCase() === 'INBOX' || currentFolder.value?.specialUse === '\\Inbox'))
    changedInboxAccounts.clear()
    if (affected) void loadMessages(undefined, false, true)
  }, 300)
}
watch(() => query.value.trim(), (value, _previous, onCleanup) => {
  if (value === appliedQuery.value) return
  const timer = setTimeout(() => {
    appliedQuery.value = value
    void loadMessages()
  }, 300)
  onCleanup(() => clearTimeout(timer))
})

watch(lastChange, change => {
  if (change) changedInboxAccounts.add(change.id)
  refreshChangedInbox()
}, { flush: 'sync' })
watch([loading, busy], refreshChangedInbox)
function invalidateRequests() {
  clearTimeout(inboxRefresh)
  inboxRefresh = undefined
  changedInboxAccounts.clear()
  requestVersion++
  readVersion++
}
onUnmounted(invalidateRequests)
watch(accountBoundaryEpoch, () => {
  invalidateRequests()
  accounts.value = []
  void chooseAccount('')
}, { flush: 'sync' })
const route = useRoute()
const router = useRouter()
const accountsLoaded = ref(false)
watch([accountsLoaded, busy, () => route.query.composeTo], async ([ready, sending, recipient]) => {
  if (!ready || sending || route.name !== 'mail' || !isMailRecipient(recipient)) return
  const { composeTo, ...query } = route.query
  const draft = compose.value
  if (draft && (draft.to !== initialCompose?.to || draft.subject !== initialCompose?.subject
    || draft.text !== initialCompose?.text || draft.senderId !== initialCompose?.senderId)) {
    const accepted = await confirmDialog({ title: t('pageUi.discardChangesTitle'), message: t('pageUi.newMailDiscardHint'), confirmText: t('pageUi.discardChanges') })
    if (route.name !== 'mail' || route.query.composeTo !== recipient || compose.value !== draft) return
    if (!accepted) { await router.replace({ query }); return }
  }
  startCompose(undefined, recipient)
  await router.replace({ query })
})
watch([accountsLoaded, busy, () => route.query.draftAccount, () => route.query.draftMailbox, () => route.query.draftUid, () => route.query.draftValidity], async ([ready, occupied, target, path]) => {
  if (!ready || occupied || route.name !== 'mail' || typeof target !== 'string' || typeof path !== 'string'
    || !accounts.value.some(item => item.id === target)) return
  const { draftAccount, draftMailbox, draftUid, draftValidity, ...query } = route.query
  const valid = () => route.name === 'mail' && route.query.draftAccount === target && route.query.draftMailbox === path
    && route.query.draftUid === draftUid && route.query.draftValidity === draftValidity
  if (compose.value && !await confirmDialog({ title: t('pageUi.openDraftTitle'), message: t('pageUi.openDraftDiscardHint'), confirmText: t('pageUi.openDraft') })) {
    if (valid()) await router.replace({ query })
    return
  }
  if (!valid()) return
  await chooseAccount(target)
  const draftFolder = folders.value.find(item => item.path === path && item.specialUse === '\\Drafts')
  if (!valid() || !draftFolder) return
  await chooseFolder(draftFolder.path)
  if (!valid()) return
  const uid = typeof draftUid === 'string' ? Number(draftUid) : 0
  if (Number.isSafeInteger(uid) && uid > 0 && typeof draftValidity === 'string' && /^\d+$/u.test(draftValidity)) {
    await read({ accountId: target, mailbox: path, uid, validity: draftValidity,
      subject: '', from: '', replyTo: '', to: [], seen: true, date: null } as MailLocatedMessage)
  }
  if (valid()) await router.replace({ query })
})
onMounted(async () => { await loadAccounts('', true); accountsLoaded.value = true })
</script>

<template>
  <section class="mail-page">
    <MailAccountForm v-if="accountForm" :key="accountForm === 'add' ? 'add' : accountForm.id" :account="accountForm === 'add' ? undefined : accountForm" @cancel="accountForm = undefined"
      @saved="saved => { accountForm = undefined; clearMailViewCache(); void loadAccounts(saved.id) }" />
    <div class="mail-columns" :class="{ 'show-reading': compactPane === 'reading' }">
      <nav class="glass-card mail-folders" data-overlay-scrollbar-owner :aria-label="$t('pageUi.accountsAndFolders')">
        <header class="mail-pane-toolbar">
          <h2>{{ $t('pageUi.mail') }}</h2>
          <RefreshButton v-if="accounts.length" :title="$t('pageUi.refreshMail')" :loading="loading" :disabled="busy" @click="refreshMailbox" />
          <ActionButton v-if="senders.length" fit type="button" :aria-label="$t('pageUi.compose')" :title="$t('pageUi.compose')"
            :disabled="busy" @click="startCompose()"><PhPencilSimpleLine :size="16" /></ActionButton>
        </header>
        <div class="mail-pane-scroll scroll-surface">
          <button type="button" class="mail-nav-row" :aria-pressed="isAggregate && !unreadOnly" :disabled="busy || !accounts.length" @click="chooseAccount('')">
            <RiInboxLine class="mail-nav-icon" size="16px" aria-hidden="true" />{{ $t('pageUi.allInbox') }}
          </button>
          <button type="button" class="mail-nav-row" :aria-pressed="unreadOnly" :disabled="busy || !accounts.length" @click="chooseAccount('', true)">
            <RiMailUnreadLine class="mail-nav-icon" size="16px" aria-hidden="true" />{{ $t('pageUi.unreadMail') }}
            <span v-if="unreadTotal" class="mail-nav-count">{{ unreadTotal }}</span>
          </button>
          <section class="mail-nav-group" :aria-label="$t('pageUi.emailAccounts')">
            <h3>{{ $t('pageUi.emailAccounts') }}</h3>
            <div v-for="entry in accounts" :key="entry.id" class="mail-account-row">
              <button type="button" class="mail-nav-row" :title="entry.email"
                :aria-pressed="entry.id === accountId" :disabled="busy" @click="chooseAccount(entry.id)">
                <MailProviderIcon :src="mailProviderForAccount(entry).icon" />
                <span class="mail-account-label"><strong>{{ entry.displayName || entry.email }}</strong>
                  <small v-if="entry.displayName">{{ entry.email }}</small>
                  <small v-if="entry.receiveOnly">{{ $t('pageUi.receiveOnly') }}</small>
                </span>
                <span v-if="unreadCounts[entry.id]" class="mail-nav-count">{{ unreadCounts[entry.id] }}</span>
              </button>
              <div class="mail-account-actions">
                <button type="button" :title="$t('pageUi.reconnectAccount', { email: entry.email })" :aria-label="$t('pageUi.reconnectAccount', { email: entry.email })"
                  :disabled="busy" @click="accountForm = entry"><PhArrowClockwise :size="15" aria-hidden="true" /></button>
                <button type="button" :title="$t('pageUi.disconnectAccount', { email: entry.email })" :aria-label="$t('pageUi.disconnectAccount', { email: entry.email })"
                  :disabled="busy" @click="disconnect(entry)"><PhLinkBreak :size="15" aria-hidden="true" /></button>
              </div>
            </div>
            <button type="button" class="mail-nav-row" :disabled="busy" @click="accountForm = 'add'">
              <PhPlus :size="16" />{{ $t('pageUi.addMailbox') }}
            </button>
          </section>
          <section v-if="account && folders.length" class="mail-nav-group">
            <h3>{{ $t('pageUi.folders') }}</h3>
            <button v-for="item in folders" :key="item.path" type="button" class="mail-nav-row" :aria-pressed="item.path === folder"
              :disabled="busy" @click="chooseFolder(item.path)"><PhFolder :size="15" /><span>{{ folderLabel(item) }}</span></button>
          </section>
        </div>
      </nav>
      <section class="glass-card mail-list" data-overlay-scrollbar-owner :aria-busy="loading">
        <header class="mail-pane-toolbar">
          <SearchInput v-model="query" :placeholder="$t('pageUi.searchMail')" clearable />
        </header>
        <div class="mail-pane-scroll scroll-surface" :class="{ 'empty-state-viewport': !visibleMessages?.length }"
          @scroll.passive="onListScroll">
        <h3 class="mail-list-title">{{ unreadOnly ? $t('pageUi.unreadMail') : isAggregate ? $t('pageUi.allInbox') : currentFolder && folderLabel(currentFolder) }}</h3>
        <p v-if="updatingList" class="mail-update-status" role="status">{{ $t('pageUi.updatingMail') }}</p>
        <p v-if="refreshError" class="mail-update-status mail-error" role="status">{{ $t('pageUi.mailUpdateFailed') }}{{ refreshError }}</p>
        <p v-if="error && compactPane === 'list'" role="alert" class="mail-error">{{ error }}</p>
        <p v-if="unavailableAccounts.length" role="status" class="mail-error">{{ $t('pageUi.unavailable') }} {{ unavailableAccounts.join('、') }}</p>
        <button v-for="item in visibleMessages" :key="rowKey(item)" type="button" class="mail-row" :class="{ unread: !item.seen }"
          :aria-pressed="!!activeMessage && rowKey(activeMessage) === rowKey(item)" :disabled="busy" @click="read(item)">
          <span class="mail-row-meta"><span :title="item.from">{{ item.fromName || item.from }}</span><time v-if="item.date">{{ new Date(item.date).toLocaleString(locale) }}</time></span>
          <span class="mail-row-subject">
            <strong>{{ item.subject || $t('pageUi.noSubject') }}</strong>
            <PhPaperclip v-if="item.hasAttachments || getReadMail(rowKey(item))?.attachments.length"
              class="mail-row-attachment" :size="14" role="img" :aria-label="$t('pageUi.hasAttachment')"><title>{{ $t('pageUi.hasAttachment') }}</title></PhPaperclip>
          </span>
          <span v-if="item.snippet || getReadMail(rowKey(item))?.text" class="mail-snippet">{{ item.snippet || getReadMail(rowKey(item))?.text.trim().slice(0, 240) }}</span>
          <span v-if="isAggregate" class="mail-row-account">
            <MailProviderIcon :src="accountById.has(located(item)?.accountId ?? '') ? mailProviderForAccount(accountById.get(located(item)?.accountId ?? '')!).icon : null" />
            <span>{{ accountLabels.get(located(item)?.accountId ?? '') }}</span>
          </span>
        </button>
        <div v-if="loading && !hasList" class="mail-list-loading" role="status" aria-live="polite">
          <SkeletonGate>
            <div class="mail-list-loading-inner"><SkeletonBlock style="--skeleton-width: 88px; --skeleton-height: 10px" /><span>{{ $t('pageUi.loadingMail') }}</span></div>
          </SkeletonGate>
        </div>
        <FirstUseEmptyState v-else-if="!error && !visibleMessages?.length"
          :title="!accounts.length ? $t('pageUi.noAccounts') : appliedQuery ? $t('pageUi.noMailMatch') : unreadOnly ? $t('pageUi.noUnread') : $t('pageUi.noMail')"
          :description="!accounts.length ? $t('pageUi.addMailHint') : appliedQuery ? $t('pageUi.tryAnother') : ''">
          <template #icon><RiInboxLine size="22px" /></template>
        </FirstUseEmptyState>
        <p v-if="paginationError" role="alert" class="mail-error">{{ paginationError }}</p>
        <div v-if="loadingMore" class="mail-pagination-status" role="status">{{ $t('pageUi.loadingMoreMail') }}</div>
        <ActionButton v-else-if="nextPage !== null" class="mail-load-more" fit variant="secondary"
          :disabled="loading || busy" @click="loadMore()"><PhCaretDown :size="14" aria-hidden="true" />{{ paginationError ? $t('pageUi.retryLoading') : $t('pageUi.loadMore') }}</ActionButton>
        </div>
      </section>
      <section class="glass-card mail-content" data-overlay-scrollbar-owner :aria-busy="reading">
        <header class="mail-pane-toolbar mail-reading-toolbar">
          <ActionButton class="mail-back" fit variant="secondary" :disabled="busy" :aria-label="$t('pageUi.backToMail')" :title="$t('pageUi.backToMail')"
            @click="compactPane = 'list'"><PhCaretLeft :size="16" /></ActionButton>
          <template v-if="(selected || reading) && !compose">
            <ActionButton v-if="currentFolder?.specialUse === '\\Drafts'" fit variant="secondary" :disabled="busy || reading" @click="startCompose('draft')"><PhPencilSimpleLine :size="14" />{{ $t('pageUi.editDraft') }}</ActionButton>
            <ActionButton v-else-if="(selected || activeMessage)?.replyTo" fit variant="secondary" :disabled="busy || reading" @click="startCompose('reply')"><RiReplyLine size="14px" aria-hidden="true" />{{ $t('pageUi.reply') }}</ActionButton>
            <ActionButton fit variant="secondary" :disabled="busy || reading" @click="startCompose('forward')"><RiShareForwardFill size="14px" aria-hidden="true" />{{ $t('pageUi.forward') }}</ActionButton>
            <ActionButton fit variant="secondary" :disabled="busy || reading || updatingSeen" @click="updateMessage('seen')" ><RiMailUnreadLine v-if="(selected || activeMessage)?.seen" size="14px" aria-hidden="true" /><RiMailOpenLine v-else size="14px" aria-hidden="true" />{{ (selected || activeMessage)?.seen ? $t('pageUi.markUnread') : $t('pageUi.markRead') }}</ActionButton>
            <ActionButton v-if="currentFolder?.specialUse !== '\\Archive' && (isAggregate || folders.some(item => item.specialUse === '\\Archive'))" fit variant="secondary" :disabled="busy || reading" @click="updateMessage('archive')"><PhArchive :size="14" />{{ $t('pageUi.archive') }}</ActionButton>
            <ActionButton v-if="currentFolder?.specialUse === '\\Trash'" fit variant="secondary" :disabled="busy || reading" @click="updateMessage('inbox')"><RiInboxLine size="14px" aria-hidden="true" />{{ $t('pageUi.moveToInbox') }}</ActionButton>
            <ActionButton v-else-if="isAggregate || folders.some(item => item.specialUse === '\\Trash')" fit variant="secondary" :disabled="busy || reading" @click="updateMessage('trash')"><PhTrash :size="14" />{{ $t('pageUi.moveToTrash') }}</ActionButton>
            <ActionButton v-if="selected && hasRemoteImages && selected.unavailableImages !== 0" class="mail-load-images" fit variant="secondary"
              :disabled="loadingImages" @click="loadRemoteImages" ><PhImage :size="14" />{{ loadingImages ? $t('pageUi.loadingImages') : selected.unavailableImages ? $t('pageUi.retryImages', { count: selected.unavailableImages }) : $t('pageUi.loadImages') }}</ActionButton>
            <span v-else-if="selected?.unavailableImages" class="mail-image-status" role="status">{{ $t('pageUi.imageUnavailable', { count: selected.unavailableImages }) }}</span>
          </template>
          <template v-else-if="compose">
            <h3>{{ $t('pageUi.compose') }}</h3>
            <div class="mail-compose-actions">
              <ActionButton fit variant="secondary" type="button" :disabled="busy" @click="compose = undefined"><PhX :size="14" />{{ $t('common.actions.cancel') }}</ActionButton>
              <ActionButton fit variant="secondary" type="button" :disabled="busy || !compose.senderId" @click="submit(false)"><PhFloppyDisk :size="14" />{{ $t('pageUi.saveDraft') }}</ActionButton>
              <ActionButton fit type="button" :disabled="busy || sendUnconfirmed || !compose.senderId" @click="submit(true)"><PhPaperPlaneTilt :size="14" />{{ $t('pageUi.send') }}</ActionButton>
            </div>
          </template>
          <h3 v-else>{{ $t('pageUi.mailBody') }}</h3>
        </header>
        <div class="mail-pane-scroll mail-reading-scroll scroll-surface" :class="{ 'has-message': (selected || reading) && !compose, 'has-html': readingHtml && !compose, 'is-composing': compose, 'empty-state-viewport': !selected && !reading && !compose }">
          <p v-if="error && compactPane === 'reading'" role="alert" class="mail-error">{{ error }}</p>
        <section v-if="compose" class="mail-compose">
          <section class="mail-compose-section">
            <h3 class="mail-compose-title">{{ $t('pageUi.sender') }}</h3>
            <p v-if="!senders.length" class="mail-error">{{ $t('pageUi.addSenderFirst') }}</p>
            <SelectPopup v-model="compose.senderId" :options="senders.map(item => ({ value: item.id, label: item.displayName ? `${item.displayName} · ${item.email}` : item.email }))"
              :aria-label="$t('pageUi.sender')" :disabled="busy || sendUnconfirmed || !!compose.replyTo || !!compose.replace" />
            <ActionButton v-if="!compose.replyTo && !compose.replace && defaultSenderId !== compose.senderId" fit variant="secondary" type="button" :disabled="busy" @click="rememberSender"><PhCheck :size="14" />{{ $t('pageUi.defaultSendingAccount') }}</ActionButton>
          </section>
          <section class="mail-compose-section">
            <h3 class="mail-compose-title">{{ $t('pageUi.recipient') }}</h3>
            <input v-model="compose.to" class="form-input" :aria-label="$t('pageUi.recipient')" :placeholder="$t('pageUi.commaAddresses')" />
          </section>
          <section class="mail-compose-section">
            <h3 class="mail-compose-title">{{ $t('pageUi.subject') }}</h3>
            <input v-model="compose.subject" class="form-input" :aria-label="$t('pageUi.subject')" maxlength="998" />
          </section>
          <section class="mail-compose-section mail-compose-body">
            <h3 class="mail-compose-title">{{ $t('pageUi.body') }}</h3>
            <MailMessageEditor v-model="compose.text" />
          </section>
        </section>
        <article v-else-if="reading" class="mail-message mail-loading" role="status">
          <MailMessageHeading v-if="activeMessage" :message="activeMessage" :account="accountLabels.get(activeMessage.accountId)" />
          <span class="mail-loading-status">{{ $t('pageUi.loadingMail') }}</span>
          <SkeletonGate>
            <div class="mail-loading-lines" aria-hidden="true">
              <SkeletonBlock v-for="width in ['90%', '76%', '84%', '52%']" :key="width" :style="{ '--skeleton-width': width }" />
            </div>
          </SkeletonGate>
        </article>
        <article v-else-if="selected" class="mail-message" :class="{ 'has-html': readingHtml }">
          <MailMessageHeading :message="selected" :account="activeMessage ? accountLabels.get(activeMessage.accountId) : undefined"
            :can-reply="!!selected.replyTo && !busy && currentFolder?.specialUse !== '\\Drafts'" @reply="startCompose('reply')" />
          <section v-if="selected.attachments.length" class="mail-attachments" :aria-label="$t('pageUi.mailAttachments')">
            <h3><PhPaperclip :size="14" aria-hidden="true" />{{ $t('pageUi.attachments') }} <span>{{ selected.attachments.length }}</span></h3>
            <ul class="mail-attachment-grid">
              <li v-for="(name, index) in selected.attachments" :key="index" class="mail-attachment">
                <span class="mail-attachment-icon">
                  <component :is="fileListIcon(splitName(name).ext)" :size="18" aria-hidden="true" />
                </span>
                <span class="mail-attachment-name" :title="name">{{ name }}</span>
                <button type="button" class="mail-attachment-download" :disabled="busy" :aria-label="$t('pageUi.saveNamedFile', { name })"
                  :title="$t('pageUi.saveToFiles')" @click="saveAttachment(index)">
                  <PhDownloadSimple :size="15" aria-hidden="true" />
                </button>
              </li>
            </ul>
          </section>
          <iframe v-if="readingHtml" class="mail-html" :title="$t('pageUi.mailBody')" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" :srcdoc="readingHtml" />
          <div v-else class="mail-body">{{ selected.text }}</div>
        </article>
        <FirstUseEmptyState v-else-if="!error || compactPane !== 'reading'" :title="$t('pageUi.noSelectedMail')" :description="$t('pageUi.chooseMail')">
          <template #icon><RiMailOpenLine size="22px" /></template>
        </FirstUseEmptyState>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.mail-pane-toolbar { display: flex; align-items: center; gap: var(--space-xs); }
.mail-pane-toolbar h2 { margin-inline-end: auto; }
.mail-reading-toolbar { flex-wrap: wrap; }
.mail-reading-scroll { padding: var(--page-content-inset); }
.mail-nav-group { display: grid; gap: var(--space-xs); border-top: 1px solid var(--content-divider); margin-top: var(--space-sm); padding-top: var(--space-sm); }
.mail-nav-group h3, .mail-list-title { padding: var(--space-sm); color: var(--content-secondary); font-size: var(--font-size-sm); }
.mail-row { width: 100%; text-align: left; border: 1px solid transparent; border-radius: var(--radius-sm); padding: var(--space-md); font: inherit; color: var(--content-primary); background: transparent; cursor: pointer; }
.mail-row[aria-pressed=true] { border-color: var(--mind-note-border-selected); }
.mail-account-label { display: grid; min-width: 0; }
.mail-account-label, .mail-row { line-height: var(--line-height-ui); }
.mail-account-label strong, .mail-account-label small, .mail-nav-row > span, .mail-row strong, .mail-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mail-account-label small, .mail-row span, time { color: var(--content-secondary); font-size: var(--font-size-sm); }
.mail-account-row { position: relative; min-width: 0; }
.mail-account-row .mail-nav-row { padding-inline-end: 54px; }
.mail-account-actions {
  position: absolute; inset-inline-end: var(--space-sm); top: 50%; transform: translateY(-50%);
  display: flex; gap: var(--space-xs); transition: opacity var(--motion-hover-control);
}
.mail-account-actions button, .mail-attachment-download {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border: none; border-radius: var(--radius-compact);
  background: transparent; color: var(--content-tertiary); cursor: pointer;
  transition: background-color var(--motion-hover-control), color var(--motion-hover-control);
}
.mail-account-actions button:hover:not(:disabled),
.mail-attachment-download:is(:hover, :focus-visible):not(:disabled) {
  background: color-mix(in srgb, var(--action-primary) 12%, transparent); color: var(--content-primary);
}
.mail-account-actions button:last-child:hover:not(:disabled) { background: var(--status-danger-bg); color: var(--status-danger); }
.mail-account-actions button:focus-visible, .mail-attachment-download:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.mail-account-actions button:disabled, .mail-attachment-download:disabled { color: var(--content-disabled); cursor: default; }
@media (hover: hover) and (pointer: fine) {
  .mail-account-row:not(:hover):not(:focus-within) .mail-nav-row { padding-inline-end: var(--space-sm); }
  .mail-account-row:not(:hover):not(:focus-within) .mail-account-actions { opacity: 0; pointer-events: none; }
}
.mail-row { display: grid; gap: var(--space-xs); margin-bottom: var(--space-xs); padding: var(--space-md); background: var(--mind-notes-list-card-bg); box-shadow: var(--elevation-card); transition: var(--card-motion); }
.mail-row { position: relative; }
.mail-row::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: var(--card-hover-overlay); box-shadow: inset 0 1px 0 var(--highlight-soft); opacity: 0; transition: opacity var(--hover-motion-card); pointer-events: none; }
.mail-row:hover::after { opacity: 1; }
.mail-row:hover { transform: translateY(-1px); border-color: var(--border-hover); box-shadow: var(--elevation-card-hover); }
.mail-row:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.mail-row:not(.unread) strong { font-weight: 500; }
.mail-row.unread .mail-row-meta > span::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-inline-end: var(--space-xs); border-radius: 50%; background: var(--action-primary); vertical-align: middle; }
.mail-row-meta { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-sm); }
.mail-row-meta time { flex-shrink: 0; }
.mail-row .mail-row-account { display: flex; align-items: center; gap: var(--space-xs); min-width: 0; }
.mail-row-account :deep(.mail-provider-icon) { width: 14px; height: 14px; }
.mail-row .mail-row-subject { display: flex; align-items: center; gap: var(--space-xs); color: var(--content-primary); font-size: inherit; }
.mail-row-subject strong { flex: 1; }
.mail-row-attachment { flex: none; color: var(--content-secondary); }
.mail-reading-scroll.is-composing, .mail-compose {
  display: flex;
  flex-direction: column;
}
.mail-compose { flex: 1 0 auto; gap: var(--space-md); min-width: 0; }
.mail-compose-section { display: grid; gap: var(--space-sm); min-width: 0; }
.mail-compose-section + .mail-compose-section {
  border-top: 1px solid var(--content-divider);
  padding-top: var(--space-md);
}
.mail-compose-title {
  margin: 0;
  color: var(--content-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
}
.mail-compose-body { display: flex; flex: 1 0 auto; flex-direction: column; }
.mail-content, .mail-body { overflow-wrap: anywhere; }
.mail-body { padding: var(--page-content-inset); white-space: pre-wrap; line-height: 1.65; }
.mail-reading-scroll.has-message { padding: 0; background: var(--palette-surface, var(--surface-canvas-card)); }
.mail-reading-scroll.has-html { display: flex; flex-direction: column; overflow: hidden; }
.mail-message.has-html { flex: 1 1 0; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.mail-html { width: 100%; flex: 1; min-height: 0; display: block; border: 0; }
.mail-attachments { border-bottom: 1px solid var(--content-divider); padding: var(--page-content-inset); }
.mail-message.has-html .mail-attachments { flex: 0 0 auto; max-height: 32%; overflow: auto; }
.mail-attachments h3 { display: flex; align-items: center; gap: var(--space-xs); margin: 0 0 var(--space-sm); font-size: var(--font-size-sm); }
.mail-attachments h3 span { color: var(--content-secondary); }
.mail-attachment-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr)); gap: var(--space-sm); margin: 0; padding: 0; list-style: none; }
.mail-attachment { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; padding: var(--space-xs) var(--space-sm); border: 1px solid var(--content-divider); border-radius: var(--radius-sm); background: var(--mind-notes-list-card-bg); }
.mail-attachment-icon { display: grid; place-items: center; flex: none; color: var(--content-secondary); }
.mail-attachment-download { flex: none; width: 28px; height: 28px; color: var(--content-secondary); }
.mail-attachment-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-sm); line-height: var(--line-height-body); }
.mail-load-images { margin-inline-start: auto; }
.mail-image-status { color: var(--content-secondary); font-size: var(--font-size-sm); }
.mail-compose-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; margin-inline-start: auto; gap: var(--space-sm); }
.mail-row .mail-snippet { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.empty-state-viewport .mail-list-loading { flex: 1; }
.mail-list-loading { min-height: 140px; display: grid; place-items: center; color: var(--content-secondary); }
.mail-update-status { margin: 0; padding: 0 var(--space-sm) var(--space-sm); color: var(--content-secondary); font-size: var(--font-size-sm); }
.mail-list-loading-inner { display: grid; justify-items: center; gap: var(--space-sm); }
.mail-load-more.app-action-button, .mail-pagination-status { width: 100%; }
.mail-pagination-status {
  display: grid; place-items: center; min-height: 34px;
  border-radius: var(--radius-xs); background: var(--surface-soft);
  color: var(--content-secondary); font-size: var(--font-size-sm);
}
.mail-loading-status { display: block; padding: var(--page-content-inset) var(--page-content-inset) 0; color: var(--content-secondary); }
.mail-loading-lines { display: grid; gap: var(--space-md); padding: var(--page-content-inset); }
.mail-error { color: var(--status-danger); }
h2, h3 { margin: 0; }
.mail-pane-toolbar h2, .mail-reading-scroll h2 { font-size: var(--font-size-title); overflow-wrap: anywhere; }
.mail-back { display: none; }
@container (max-width: 740px) {
  .show-reading .mail-back { display: inline-flex; }
}
</style>

<style scoped src="./mail-layout.css"></style>
