<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { mailCommand, type MailAccountSummary, type MailAttachment, type MailCommand, type MailDraft, type MailFolder, type MailMessage, type MailPage, type MailRead } from '@gugu/core/mail/contracts'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { useMailAccess } from '@/api/mail'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { errorMessage, showAppSuccess } from '@/composables/core/useAppToast'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import MailAccountForm from './MailAccountForm.vue'

const pathFilesApi = usePathFileAccess()

const { preview, request: requestMail } = useMailAccess()
const accounts = ref<MailAccountSummary[]>([])
const accountId = ref('')
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
const accountForm = ref<'add' | 'edit'>()
type MessageRef = { mailbox: string; uid: number; validity: string }
const compose = ref<{ to: string; subject: string; text: string; attemptId: string; replace?: MessageRef; replyTo?: MessageRef }>()
const sendUnconfirmed = ref(false)
let requestVersion = 0

function folderLabel(value: MailFolder) {
  return ({ '\\Inbox': '收件箱', '\\Drafts': '草稿', '\\Sent': '已发送', '\\Trash': '垃圾箱', '\\Archive': '归档' } as Record<string, string>)[value.specialUse ?? ''] ?? value.name
}

async function loadAccounts(preferred = accountId.value) {
  loading.value = true
  error.value = ''
  try {
    accounts.value = await requestMail<MailAccountSummary[]>({ action: 'accounts' })
    await chooseAccount(accounts.value.find(item => item.id === preferred)?.id ?? accounts.value[0]?.id ?? '')
  } catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
}

async function chooseAccount(id: string) {
  const version = ++requestVersion
  accountId.value = id
  folders.value = []
  folder.value = ''
  messages.value = undefined
  selected.value = undefined
  compose.value = undefined
  query.value = ''
  error.value = ''
  if (!id) return
  loading.value = true
  try {
    const result = await requestMail<MailFolder[]>({ action: 'folders', accountId: id })
    if (version !== requestVersion) return
    folders.value = result
    const next = result.find(item => item.specialUse === '\\Inbox') ?? result[0]
    if (next) await chooseFolder(next.path)
  } catch (cause) { if (version === requestVersion) error.value = errorMessage(cause) }
  finally { if (version === requestVersion) loading.value = false }
}

async function chooseFolder(path: string) {
  folder.value = path
  query.value = ''
  appliedQuery.value = ''
  await loadMessages()
}

async function loadMessages(before?: number) {
  if (!accountId.value || !folder.value) return
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  if (!before) { messages.value = undefined; selected.value = undefined }
  try {
    const next = await requestMail<MailPage>({
      action: 'messages', accountId: accountId.value, mailbox: folder.value, query: appliedQuery.value, before,
    })
    if (version !== requestVersion) return
    const previous = messages.value
    messages.value = before && previous?.validity === next.validity
      ? { ...next, items: [...previous.items, ...next.items.filter(item => !previous.items.some(known => known.uid === item.uid))] }
      : next
  } catch (cause) { if (version === requestVersion) error.value = errorMessage(cause) }
  finally { if (version === requestVersion) loading.value = false }
}

async function read(item: MailMessage) {
  if (!messages.value) return
  const version = ++requestVersion
  error.value = ''
  selected.value = undefined
  try {
    const result = await requestMail<MailRead>({
      action: 'read', accountId: accountId.value, mailbox: folder.value, validity: messages.value.validity, uid: item.uid,
    })
    if (version === requestVersion) selected.value = result
  } catch (cause) { if (version === requestVersion) error.value = errorMessage(cause) }
}

async function updateMessage(action: 'seen' | 'archive' | 'trash' | 'inbox') {
  if (!selected.value || !messages.value || busy.value) return
  const item = selected.value
  const ref = { accountId: accountId.value, mailbox: folder.value, validity: messages.value.validity, uid: item.uid }
  if (action === 'trash' && !await confirmDialog({ title: '移入垃圾箱', message: item.subject || '无主题' })) return
  if (ref.accountId !== accountId.value || ref.mailbox !== folder.value || selected.value !== item) return
  await perform(async () => {
    if (action === 'seen') {
      await requestMail({ action, ...ref, seen: !item.seen })
      item.seen = !item.seen
      const row = messages.value?.items.find(message => message.uid === item.uid)
      if (row) row.seen = item.seen
    } else {
      await requestMail({ action: 'move', ...ref, target: action })
      await loadMessages()
    }
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
  if (!selected.value || !messages.value) return
  const reference = { accountId: accountId.value, mailbox: folder.value, validity: messages.value.validity, uid: selected.value.uid }
  await perform(async () => {
    const result = await requestMail<MailAttachment>({ action: 'attachment', ...reference, index })
    const data = Uint8Array.from(atob(result.data), char => char.charCodeAt(0))
    const file = new File([data], result.name)
    await pathFilesApi.upload({ directoryId: 'personal', relativePath: result.name }, file, () => {})
    showAppSuccess('附件已保存到个人文件')
  })
}

async function disconnect() {
  const current = account.value
  if (!current || !await confirmDialog({ title: '断开邮箱', message: `断开「${current.email}」并移除本地保存的授权凭据？` })) return
  await perform(async () => {
    await requestMail({ action: 'disconnect', accountId: current.id })
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

function startCompose(mode?: 'reply' | 'forward' | 'draft') {
  const item = selected.value
  const source = item && messages.value ? { mailbox: folder.value, uid: item.uid, validity: messages.value.validity } : undefined
  sendUnconfirmed.value = false
  compose.value = {
    to: mode === 'reply' ? item?.replyTo ?? '' : mode === 'draft' ? item?.to.join(', ') ?? '' : '',
    subject: mode === 'reply' ? `Re: ${item?.subject ?? ''}` : mode === 'forward' ? `Fwd: ${item?.subject ?? ''}` : mode === 'draft' ? item?.subject ?? '' : '',
    text: mode === 'draft' ? item?.text ?? '' : mode === 'forward' ? `\n\n转发邮件\n${item?.text ?? ''}` : '',
    attemptId: newAttemptId(),
    replace: mode === 'draft' ? source : undefined,
    replyTo: mode === 'reply' ? source : undefined,
  }
}

async function submit(send: boolean) {
  const value = compose.value
  const sender = account.value
  if (!value || !sender || busy.value) return
  const draft: MailDraft = { to: value.to.split(/[,，;；]/).map(item => item.trim()).filter(Boolean), subject: value.subject, text: value.text }
  const command: MailCommand = send
    ? { action: 'send', accountId: sender.id, draft, attemptId: value.attemptId, replyTo: value.replyTo }
    : { action: 'draft', accountId: sender.id, draft, replace: value.replace }
  if (!mailCommand.safeParse(command).success) { error.value = '请检查收件人地址、主题和正文长度'; return }
  if (send) {
    if (!draft.to.length) { error.value = '请填写收件人'; return }
    if (!await confirmDialog({ title: '确认发送邮件', message: `发件人 ${sender.email}\n收件人 ${draft.to.join(', ')}\n主题 ${draft.subject || '无主题'}` })) return
    if (compose.value !== value || accountId.value !== sender.id || value.subject !== draft.subject || value.text !== draft.text
      || value.to.split(/[,，;；]/).map(item => item.trim()).filter(Boolean).join(',') !== draft.to.join(',')) return
  }
  await perform(async () => {
    if (send) {
      sendUnconfirmed.value = true
      const result = await requestMail<{ partial: boolean }>(command)
      showAppSuccess(result.partial ? '已发给部分收件人，请核对地址' : '邮件已提交')
    } else {
      await requestMail(command)
      showAppSuccess('草稿已保存')
    }
    compose.value = undefined
    await loadMessages()
  })
}

onMounted(() => { void loadAccounts() })
</script>

<template>
  <section class="mail-page">
    <header class="glass-card mail-toolbar">
      <SelectPopup v-if="accounts.length" :model-value="accountId" :options="accounts.map(item => ({ value: item.id, label: item.email }))"
        aria-label="邮箱账户" :disabled="busy" @update:model-value="chooseAccount" />
      <ActionButton v-if="!preview" fit variant="secondary" :disabled="busy" @click="accountForm = 'add'">添加邮箱</ActionButton>
      <ActionButton v-if="account" fit variant="secondary" :disabled="busy" @click="accountForm = 'edit'">重新连接</ActionButton>
      <ActionButton v-if="account" fit variant="secondary" :disabled="busy" @click="disconnect">断开</ActionButton>
      <ActionButton v-if="account" fit :disabled="busy" @click="startCompose()">写邮件</ActionButton>
    </header>
    <p v-if="error" role="alert" class="mail-error">{{ error }}</p>
    <div v-if="accountForm" class="glass-card">
      <MailAccountForm :account="accountForm === 'edit' ? account : undefined" @cancel="accountForm = undefined"
        @saved="saved => { accountForm = undefined; void loadAccounts(saved.id) }" />
    </div>
    <div v-else-if="account" class="mail-columns">
      <nav class="glass-card mail-folders" aria-label="邮箱文件夹">
        <ActionButton v-for="item in folders" :key="item.path" :variant="item.path === folder ? 'primary' : 'secondary'" :disabled="busy" @click="chooseFolder(item.path)">
          {{ folderLabel(item) }}
        </ActionButton>
      </nav>
      <div class="glass-card mail-list" :aria-busy="loading">
        <form class="mail-search" @submit.prevent="appliedQuery = query.trim(); loadMessages()">
          <input v-model="query" type="search" class="form-input" maxlength="120" aria-label="搜索邮件" placeholder="搜索当前文件夹" />
          <ActionButton fit variant="secondary" type="submit" :disabled="busy || loading">搜索</ActionButton>
          <ActionButton fit variant="secondary" type="button" :disabled="busy || loading" @click="loadMessages()">刷新</ActionButton>
        </form>
        <button v-for="item in messages?.items" :key="item.uid" type="button" class="mail-row" :class="{ unread: !item.seen }"
          :aria-pressed="selected?.uid === item.uid" :disabled="busy" @click="read(item)">
          <strong>{{ item.subject || '无主题' }}</strong><span>{{ item.from }}</span>
        </button>
        <p v-if="loading" role="status">正在读取邮件</p>
        <p v-else-if="!messages?.items.length">暂无邮件</p>
        <ActionButton v-if="messages?.next != null" fit variant="secondary" :disabled="loading || busy" @click="loadMessages(messages.next)">加载更多</ActionButton>
      </div>
      <div class="glass-card mail-content">
        <form v-if="compose" class="mail-compose" @submit.prevent="submit(true)">
          <span>收件人</span><input v-model="compose.to" class="form-input" aria-label="收件人" placeholder="多个地址用逗号分隔" />
          <span>主题</span><input v-model="compose.subject" class="form-input" aria-label="主题" maxlength="998" />
          <span>正文</span><textarea v-model="compose.text" class="form-input" aria-label="正文" maxlength="100000" rows="10" />
          <div class="mail-toolbar">
            <ActionButton fit variant="secondary" type="button" :disabled="busy" @click="compose = undefined">取消</ActionButton>
            <ActionButton fit variant="secondary" type="button" :disabled="busy" @click="submit(false)">保存草稿</ActionButton>
            <ActionButton fit type="submit" :disabled="busy || sendUnconfirmed">发送</ActionButton>
          </div>
        </form>
        <article v-else-if="selected">
          <h2>{{ selected.subject || '无主题' }}</h2>
          <p>{{ selected.from }} <time v-if="selected.date">{{ new Date(selected.date).toLocaleString() }}</time></p>
          <div class="mail-toolbar">
            <ActionButton v-if="currentFolder?.specialUse === '\\Drafts'" fit variant="secondary" :disabled="busy" @click="startCompose('draft')">编辑草稿</ActionButton>
            <ActionButton v-else-if="selected.replyTo" fit variant="secondary" :disabled="busy" @click="startCompose('reply')">回复</ActionButton>
            <ActionButton fit variant="secondary" :disabled="busy" @click="startCompose('forward')">转发</ActionButton>
            <ActionButton fit variant="secondary" :disabled="busy" @click="updateMessage('seen')">{{ selected.seen ? '标为未读' : '标为已读' }}</ActionButton>
            <ActionButton v-if="currentFolder?.specialUse !== '\\Archive' && folders.some(item => item.specialUse === '\\Archive')" fit variant="secondary" :disabled="busy" @click="updateMessage('archive')">归档</ActionButton>
            <ActionButton v-if="currentFolder?.specialUse === '\\Trash'" fit variant="secondary" :disabled="busy" @click="updateMessage('inbox')">移回收件箱</ActionButton>
            <ActionButton v-else-if="folders.some(item => item.specialUse === '\\Trash')" fit variant="secondary" :disabled="busy" @click="updateMessage('trash')">移入垃圾箱</ActionButton>
          </div>
          <div class="mail-body">{{ selected.text }}</div>
          <ul v-if="selected.attachments.length" aria-label="邮件附件">
            <li v-for="(name, index) in selected.attachments" :key="index">
              {{ name }} <ActionButton fit variant="secondary" :disabled="busy" @click="saveAttachment(index)">保存到个人文件</ActionButton>
            </li>
          </ul>
        </article>
        <p v-else>选择一封邮件查看</p>
      </div>
    </div>
    <div v-else class="glass-card mail-empty">{{ preview ? '请在咕咕桌面应用中连接邮箱' : loading ? '正在读取邮箱账户' : '添加邮箱后即可查看邮件' }}</div>
  </section>
</template>

<style scoped>
.mail-page { display: grid; gap: var(--space-sm); }
.mail-toolbar,.mail-search { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
header.mail-toolbar,.mail-empty,.mail-content,.mail-list,.mail-folders { padding: var(--space-md); }
.mail-columns { display: grid; grid-template-columns: minmax(120px, 160px) minmax(200px, 1fr) minmax(0, 1.7fr); gap: var(--space-sm); align-items: start; }
.mail-folders,.mail-list,.mail-compose { display: grid; gap: var(--space-sm); min-width: 0; }
.mail-search input { flex: 1; min-width: 120px; }
.mail-row { display: grid; gap: 4px; text-align: left; border: 0; border-radius: var(--radius-sm); padding: var(--space-sm); color: var(--content-primary); background: transparent; cursor: pointer; }
.mail-row:hover,.mail-row[aria-pressed=true] { background: var(--action-soft); }
.mail-row strong,.mail-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mail-row:not(.unread) strong { font-weight: 500; }
.mail-row span,time { color: var(--content-secondary); font-size: var(--font-size-sm); }
.mail-content,.mail-body { min-width: 0; overflow-wrap: anywhere; }
.mail-body { margin-block: var(--space-md); white-space: pre-wrap; }
.mail-error { color: var(--status-danger); }
@media (max-width: 900px) {
  .mail-columns { grid-template-columns: minmax(0, 1fr); }
  .mail-folders { display: flex; flex-wrap: wrap; }
}
</style>
