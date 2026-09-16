<template>
  <BaseModal :show="show" width="620px" background="var(--panel-bg)" teleport-to="body" @close="emit('close')">
    <div class="skill-form">
      <div class="form-head">
        <div><h2>{{ server ? t('skillsMcpUi.editTitle') : t('skillsMcpUi.addTitle') }}</h2><p>{{ t('skillsMcpUi.hint') }}</p></div>
        <CloseButton @click="emit('close')" />
      </div>

      <div class="form-field"><span class="field-label">{{ t('skillsMcpUi.name') }}</span><input v-model.trim="form.name" class="form-input" maxlength="64" autocomplete="off" :aria-label="t('skillsMcpUi.name')" /></div>
      <div class="form-row">
        <div class="form-field"><span class="field-label">{{ t('skillsMcpUi.transport') }}</span><SelectPopup v-model="form.transport" :options="transportOptions" /></div>
        <div class="form-field"><span class="field-label">{{ t('skillsMcpUi.timeout') }}</span><input v-model.number="form.timeout_seconds" class="form-input" type="number" min="1" max="300" :aria-label="t('skillsMcpUi.timeout')" /></div>
      </div>
      <div v-if="form.transport === 'http'" class="form-field"><span class="field-label">{{ t('skillsMcpUi.endpoint') }}</span><input v-model.trim="form.endpoint" class="form-input" autocomplete="url" :aria-label="t('skillsMcpUi.endpoint')" /></div>
      <div v-else class="form-field"><span class="field-label">{{ t('skillsMcpUi.command') }}</span><input v-model.trim="form.command" class="form-input" autocomplete="off" spellcheck="false" :aria-label="t('skillsMcpUi.command')" /></div>
      <div class="form-field"><span class="field-label">{{ t('skillsMcpUi.allowlist') }}</span><input v-model.trim="form.tool_allowlist_text" class="form-input" autocomplete="off" :aria-label="t('skillsMcpUi.allowlist')" /></div>
      <div class="form-field"><span class="field-label">{{ t('skillsMcpUi.confirmMode') }}</span><SelectPopup v-model="form.confirm_mode" :options="confirmOptions" /></div>

      <template v-if="form.transport === 'http'">
        <div class="form-field"><span class="field-label">{{ t('skillsMcpUi.headers') }}</span><textarea v-model="form.headers_text" class="form-input headers-input" :placeholder="server ? t('skillsMcpUi.headersKeep') : t('skillsMcpUi.headersPlaceholder')" autocomplete="off" spellcheck="false" :aria-label="t('skillsMcpUi.headers')" /></div>
        <p class="form-hint">{{ t('skillsMcpUi.headersHint') }}</p>
      </template>

      <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
      <div class="form-actions">
        <Checkbox v-model="form.enabled">{{ t('skillsMcpUi.enabled') }}</Checkbox>
        <span class="form-action-spacer" />
        <ActionButton variant="secondary" @click="emit('close')">{{ t('common.actions.cancel') }}</ActionButton>
        <ActionButton :disabled="busy" @click="submit">{{ busy ? t('skillsMcpUi.saving') : t('common.actions.save') }}</ActionButton>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import CloseButton from '@/components/common/overlays/CloseButton.vue'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import type { McpServerItem } from '@/services/api'
import type { McpServerDraft } from './mcp-types'

const props = defineProps<{ show: boolean; server: McpServerItem | null; busy?: boolean }>()
const emit = defineEmits<{ (event: 'close'): void; (event: 'save', draft: McpServerDraft): void }>()
const { t } = useI18n()

const transportOptions = [
  { value: 'http', label: t('skillsMcpUi.httpTransport') },
  { value: 'stdio', label: t('skillsMcpUi.stdioTransport') },
]
const confirmOptions = [
  { value: 'confirm_all', label: t('skillsMcpUi.confirmAll') },
  { value: 'auto', label: t('skillsMcpUi.autoConfirm') },
]
const server = props.server
const formError = ref('')
const form = reactive({
  name: server?.name ?? '',
  transport: (server?.transport === 'stdio' ? 'stdio' : 'http') as 'http' | 'stdio',
  endpoint: server?.endpoint ?? '',
  command: server?.command ?? '',
  timeout_seconds: server?.timeout_seconds ?? 30,
  tool_allowlist_text: server?.tool_allowlist?.join(', ') ?? '',
  confirm_mode: (server?.confirm_mode === 'auto' ? 'auto' : 'confirm_all') as 'auto' | 'confirm_all',
  enabled: server?.enabled ?? true,
  headers_text: '',
})

function parseHeaders(value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, String(entry)]))
  } catch {
    throw new Error(t('skillsMcpUi.headersInvalid'))
  }
}

function submit() {
  formError.value = ''
  if (!form.name || (form.transport === 'http' ? !form.endpoint : !form.command)) {
    formError.value = t('skillsMcpUi.fillRequired')
    return
  }
  try {
    const headers = form.transport === 'http' ? parseHeaders(form.headers_text) : undefined
    emit('save', {
      name: form.name,
      transport: form.transport,
      endpoint: form.transport === 'http' ? form.endpoint : '',
      command: form.transport === 'stdio' ? form.command : '',
      timeout_seconds: form.timeout_seconds,
      tool_allowlist: form.tool_allowlist_text.split(',').map(value => value.trim()).filter(Boolean),
      confirm_mode: form.confirm_mode,
      enabled: form.enabled,
      ...(headers ? { headers } : {}),
    })
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : t('skillsMcpUi.headersInvalid')
  }
}
</script>

<style scoped>
.skill-form { position:relative; z-index:1; isolation:isolate; padding:24px; color:var(--content-primary); max-height:calc(100vh - 48px); overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--scrollbar-thumb) transparent; }
.form-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; }.form-head h2 { margin:0; font-size:20px; }.form-head p { margin:6px 0 0; color:var(--content-secondary); font-size:12px; }.form-row { display:grid; grid-template-columns:minmax(0,1fr) 130px; gap:12px; }
.form-field { display:flex; flex-direction:column; gap:6px; margin-top:13px; color:var(--content-secondary); font-size:12px; }.field-label { display:block; line-height:var(--line-height-ui); }.form-field :deep(.select-popup) { width:100%; }.form-field :deep(.select-popup-trigger) { width:100%; }
.form-input { box-sizing:border-box; width:100%; min-height:var(--control-height-md); padding:6px 12px; border:1px solid var(--input-border); border-radius:var(--radius-sm); background:var(--input-bg); color:var(--input-fg); font:var(--font-weight-regular) var(--font-size-body)/var(--line-height-body) var(--font-sans); outline:none; box-shadow:var(--input-hover-shadow); transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }.form-input:hover { background:var(--input-bg-hover); border-color:var(--input-border-hover); }.form-input:focus { background:var(--input-bg-focus); border-color:var(--input-border-focus); box-shadow:var(--input-hover-shadow), var(--input-focus-shadow); }.headers-input { min-height:76px; resize:vertical; }.form-hint { margin:6px 0 0; color:var(--content-tertiary); font-size:11px; }.form-error { margin:12px 0 0; color:var(--status-danger); font-size:12px; }
.form-actions { display:flex; align-items:center; gap:10px; margin-top:22px; }.form-action-spacer { flex:1; }
@media (max-width:620px) { .form-row { grid-template-columns:1fr; } }
</style>
