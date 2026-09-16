<template>
  <div class="pm-section profile-mcp-pane">
    <div class="pm-section-label">{{ t('profileMcpUi.title') }}</div>
    <p class="pm-field-hint">{{ t('profileMcpUi.hint') }}</p>
    <div v-if="loading" class="pm-field-hint">{{ t('profileMcpUi.loading') }}</div>
    <div v-else-if="error" class="pm-msg err">{{ error }}</div>
    <template v-else>
      <div v-if="!items.length" class="mcp-empty pm-field-hint">{{ t('profileMcpUi.empty') }}</div>
      <div v-for="item in items" :key="item.id" class="mcp-card">
        <div class="mcp-card-main">
          <div class="mcp-card-title"><span class="mcp-state-dot" :class="`is-${item.state || 'unloaded'}`"></span>{{ item.name }}</div>
          <div class="mcp-card-meta">{{ item.transport === 'stdio' ? item.command : item.endpoint }} · {{ stateLabel(item.state) }} · {{ t('profileMcpUi.toolCount', { count: item.loaded_tool_count ?? 0 }) }}</div>
          <div v-if="item.has_credentials" class="mcp-card-credential">{{ t('profileMcpUi.credentialsConfigured') }}</div>
        </div>
        <div class="mcp-card-actions">
          <button class="pm-style-chip" :disabled="busyId === item.id" @click="test(item)">{{ busyId === item.id ? t('profileMcpUi.testing') : t('profileMcpUi.test') }}</button>
          <button class="pm-style-chip" :disabled="busyId === item.id" @click="reconnect(item)">{{ busyId === item.id ? t('profileMcpUi.testing') : t('profileMcpUi.reconnect') }}</button>
          <button class="pm-style-chip" :class="{ active: item.enabled }" :disabled="busyId === item.id" @click="toggle(item)">{{ item.enabled ? t('profileMcpUi.enabled') : t('profileMcpUi.disabled') }}</button>
          <button class="pm-style-chip" @click="openEditor(item)">{{ t('profileMcpUi.edit') }}</button>
          <button class="pm-danger-btn" :disabled="busyId === item.id" @click="remove(item)">{{ t('profileMcpUi.delete') }}</button>
        </div>
      </div>
      <div v-if="editor" class="mcp-editor">
        <div class="mcp-editor-title">{{ editor.id ? t('profileMcpUi.editTitle') : t('profileMcpUi.addTitle') }}</div>
        <div class="mcp-form-grid">
          <input v-model.trim="editor.name" class="form-input" :placeholder="t('profileMcpUi.name')" autocomplete="off" />
          <select v-model="editor.transport" class="form-input"><option value="http">{{ t('profileMcpUi.httpTransport') }}</option><option value="stdio">{{ t('profileMcpUi.stdioTransport') }}</option></select>
          <input v-if="editor.transport === 'http'" v-model.trim="editor.endpoint" class="form-input" :placeholder="t('profileMcpUi.endpoint')" autocomplete="url" />
          <input v-else v-model.trim="editor.command" class="form-input" :placeholder="t('profileMcpUi.command')" autocomplete="off" spellcheck="false" />
          <input v-model.number="editor.timeout_seconds" class="form-input" type="number" min="1" max="300" :placeholder="t('profileMcpUi.timeout')" />
          <input v-model.trim="editor.tool_allowlist_text" class="form-input" :placeholder="t('profileMcpUi.allowlist')" autocomplete="off" />
          <select v-model="editor.confirm_mode" class="form-input"><option value="confirm_all">{{ t('profileMcpUi.confirmAll') }}</option><option value="auto">{{ t('profileMcpUi.autoConfirm') }}</option></select>
          <label class="mcp-enabled"><input v-model="editor.enabled" type="checkbox" /> {{ t('profileMcpUi.enabled') }}</label>
        </div>
        <template v-if="editor.transport === 'http'">
          <label class="mcp-headers-label">{{ t('profileMcpUi.headers') }}</label>
          <textarea v-model="editor.headers_text" class="form-input mcp-headers" :placeholder="editor.id ? t('profileMcpUi.headersKeep') : t('profileMcpUi.headersPlaceholder')" autocomplete="off" spellcheck="false"></textarea>
          <p class="pm-field-hint">{{ t('profileMcpUi.headersHint') }}</p>
        </template>
        <div v-if="message" class="pm-msg" :class="messageType">{{ message }}</div>
        <div class="mcp-editor-actions"><button class="pm-style-chip" @click="editor = null">{{ t('profileMcpUi.cancel') }}</button><button class="pm-style-chip active" :disabled="saving" @click="save">{{ saving ? t('profileMcpUi.saving') : t('profileMcpUi.save') }}</button></div>
      </div>
      <div v-if="!editor" class="mcp-add-row"><span class="pm-field-hint">{{ t('profileMcpUi.limit', { count: maxServers }) }}</span><button class="pm-style-chip active" :disabled="items.length >= maxServers" @click="openEditor()">{{ t('profileMcpUi.add') }}</button></div>
      <div v-if="!editor && message" class="pm-msg" :class="messageType">{{ message }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { mcpApi, type McpServerItem } from '@/services/api'

const { t } = useI18n()
const loading = ref(false)
const saving = ref(false)
const busyId = ref<string | null>(null)
const error = ref('')
const message = ref('')
const messageType = ref<'ok' | 'err'>('ok')
const items = ref<McpServerItem[]>([])
const maxServers = ref(5)
const editor = ref<Editor | null>(null)

interface Editor {
  id?: string
  transport: 'http' | 'stdio'
  name: string
  endpoint: string
  command: string
  timeout_seconds: number
  tool_allowlist_text: string
  confirm_mode: 'auto' | 'confirm_all'
  enabled: boolean
  headers_text: string
}

function blankEditor(item?: McpServerItem): Editor {
  return { id: item?.id, transport: item?.transport === 'stdio' ? 'stdio' : 'http', name: item?.name ?? '', endpoint: item?.endpoint ?? '', command: item?.command ?? '', timeout_seconds: item?.timeout_seconds ?? 30, tool_allowlist_text: item?.tool_allowlist?.join(', ') ?? '', confirm_mode: item?.confirm_mode === 'auto' ? 'auto' : 'confirm_all', enabled: item?.enabled ?? true, headers_text: '' }
}
function stateLabel(state?: string) { return t(`profileMcpUi.state.${state || 'unloaded'}`) }
function parseHeaders(value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('profileMcpUi.headersInvalid'))
  return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, String(entry)]))
}
function payloadFor(draft: Editor) {
  const payload: Record<string, unknown> = { name: draft.name, transport: draft.transport, endpoint: draft.transport === 'http' ? draft.endpoint : '', command: draft.transport === 'stdio' ? draft.command : '', enabled: draft.enabled, confirm_mode: draft.confirm_mode, timeout_seconds: draft.timeout_seconds, tool_allowlist: draft.tool_allowlist_text.split(',').map(value => value.trim()).filter(Boolean) }
  if (draft.transport === 'http') {
    const headers = parseHeaders(draft.headers_text)
    if (headers !== undefined) payload.headers = headers
  }
  return payload
}
async function load() {
  loading.value = true; error.value = ''
  try { const result = await mcpApi.list(); items.value = result.items; maxServers.value = result.max_servers }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('profileMcpUi.loadFailed') }
  finally { loading.value = false }
}
function openEditor(item?: McpServerItem) { message.value = ''; editor.value = blankEditor(item) }
async function save() {
  if (!editor.value || saving.value) return
  saving.value = true; message.value = ''
  try { const draft = editor.value; const payload = payloadFor(draft); if (draft.id) await mcpApi.update(draft.id, payload); else await mcpApi.create(payload); editor.value = null; message.value = t('profileMcpUi.saved'); messageType.value = 'ok'; await load() }
  catch (cause) { message.value = cause instanceof Error ? cause.message : t('profileMcpUi.saveFailed'); messageType.value = 'err' }
  finally { saving.value = false }
}
async function test(item: McpServerItem) {
  busyId.value = item.id; message.value = ''
  try { const result = await mcpApi.test(item.id); message.value = result.ok ? t('profileMcpUi.testSuccess', { count: result.tool_count ?? 0 }) : (result.error || t('profileMcpUi.testFailed')); messageType.value = result.ok ? 'ok' : 'err'; await load() }
  catch (cause) { message.value = cause instanceof Error ? cause.message : t('profileMcpUi.testFailed'); messageType.value = 'err' }
  finally { busyId.value = null }
}
async function reconnect(item: McpServerItem) {
  busyId.value = item.id; message.value = ''
  try { const result = await mcpApi.reconnect(item.id); message.value = result.ok ? t('profileMcpUi.reconnectSuccess', { count: result.tool_count }) : (result.error || t('profileMcpUi.testFailed')); messageType.value = result.ok ? 'ok' : 'err'; await load() }
  catch (cause) { message.value = cause instanceof Error ? cause.message : t('profileMcpUi.testFailed'); messageType.value = 'err' }
  finally { busyId.value = null }
}
async function toggle(item: McpServerItem) {
  busyId.value = item.id
  try { await mcpApi.update(item.id, { enabled: !item.enabled }); await load() }
  catch (cause) { message.value = cause instanceof Error ? cause.message : t('profileMcpUi.saveFailed'); messageType.value = 'err' }
  finally { busyId.value = null }
}
async function remove(item: McpServerItem) {
  if (!await confirmDialog({ title: t('profileMcpUi.deleteTitle'), message: t('profileMcpUi.deleteMessage', { name: item.name }), tone: 'danger', confirmText: t('profileMcpUi.delete') })) return
  busyId.value = item.id
  try { await mcpApi.remove(item.id); message.value = t('profileMcpUi.deleted'); messageType.value = 'ok'; await load() }
  catch (cause) { message.value = cause instanceof Error ? cause.message : t('profileMcpUi.deleteFailed'); messageType.value = 'err' }
  finally { busyId.value = null }
}
onMounted(load)
</script>

<style scoped>
.profile-mcp-pane { min-width: 0; }
.mcp-empty { padding: 22px 0; }
.mcp-card { display: flex; align-items: center; gap: 14px; padding: 12px; margin-top: 10px; border: 1px solid var(--input-border, var(--divider-line)); border-radius: var(--radius-md); background: var(--surface-subtle); }
.mcp-card-main { min-width: 0; flex: 1; }
.mcp-card-title { display: flex; align-items: center; gap: 7px; color: var(--text-primary); font-size: 14px; font-weight: 650; }
.mcp-card-meta, .mcp-card-credential { margin-top: 4px; color: var(--text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-card-credential { color: var(--status-success, var(--text-secondary)); }
.mcp-state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-secondary); flex: 0 0 auto; }
.mcp-state-dot.is-ok { background: var(--status-success, #5ab899); }
.mcp-state-dot.is-error, .mcp-state-dot.is-backoff { background: var(--status-danger, #e07878); }
.mcp-card-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; flex: 0 0 auto; }
.mcp-editor { margin-top: 14px; padding: 14px; border: 1px solid var(--input-border, var(--divider-line)); border-radius: var(--radius-md); background: var(--surface-soft); }
.mcp-editor-title, .mcp-headers-label { color: var(--text-primary); font-size: 13px; font-weight: 650; }
.mcp-form-grid { display: grid; grid-template-columns: 1fr 2fr 100px; gap: 8px; margin-top: 10px; }
.mcp-form-grid .form-input { min-width: 0; height: 34px; box-sizing: border-box; }
.mcp-enabled { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 12px; }
.mcp-headers-label { display: block; margin-top: 12px; }
.mcp-headers { display: block; width: 100%; min-height: 58px; margin-top: 7px; box-sizing: border-box; resize: vertical; }
.mcp-editor-actions, .mcp-add-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
.mcp-add-row { border-top: 1px solid var(--divider-line); padding-top: 12px; }
@media (max-width: 700px) { .mcp-card { align-items: flex-start; flex-direction: column; } .mcp-card-actions { justify-content: flex-start; } .mcp-form-grid { grid-template-columns: 1fr; } }
</style>
