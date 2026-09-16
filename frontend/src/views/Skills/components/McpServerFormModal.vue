<template>
  <BaseModal :show="show" width="620px" background="var(--panel-bg)" @close="emit('close')">
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

      <div v-if="form.transport === 'http'" class="form-field"><span class="field-label">{{ t('skillsMcpUi.credentialSlots') }}</span><textarea v-model="form.credential_slots_text" class="form-input credential-slots-input control-resizable" :placeholder="credentialSlotsPlaceholder" autocomplete="off" spellcheck="false" :aria-label="t('skillsMcpUi.credentialSlots')" /></div>
      <p v-if="form.transport === 'http'" class="form-hint">{{ t('skillsMcpUi.credentialSlotsHint') }}</p>

      <p v-if="formError || submitError" class="form-error" role="alert">{{ submitError || formError }}</p>
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

const props = defineProps<{ show: boolean; server: McpServerItem | null; busy?: boolean; submitError?: string }>()
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
// 槽位定义与已保存凭据值合并回显（明文编辑；保存时值单独信封加密）
const seededSlots = (server?.credential_slots ?? []).map((slot) => {
  const value = server?.credential_values?.[slot.id]
  return value != null ? { ...slot, value } : { ...slot }
})
const form = reactive({
  name: server?.name ?? '',
  transport: (server?.transport === 'stdio' ? 'stdio' : 'http') as 'http' | 'stdio',
  endpoint: server?.endpoint ?? '',
  command: server?.command ?? '',
  timeout_seconds: server?.timeout_seconds ?? 30,
  tool_allowlist_text: server?.tool_allowlist?.join(', ') ?? '',
  confirm_mode: (server?.confirm_mode === 'auto' ? 'auto' : 'confirm_all') as 'auto' | 'confirm_all',
  enabled: server?.enabled ?? true,
  credential_slots_text: seededSlots.length
    ? JSON.stringify(seededSlots, null, 2)
    : '',
})

const credentialSlotsPlaceholder = t('skillsMcpUi.credentialSlotsPlaceholder')

function parseCredentialSlots(value: string): McpServerDraft['credential_slots'] {
  if (!value.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) throw new Error()
    return parsed.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error()
      const entry = item as Record<string, unknown>
      const target = entry.target === 'query' ? 'query' : entry.target === 'header' ? 'header' : ''
      const id = String(entry.id ?? '').trim()
      const label = String(entry.label ?? '').trim()
      const name = String(entry.name ?? '').trim()
      if (!id || !label || !target || !name) throw new Error()
      const prefix = String(entry.prefix ?? '')
      // value 字段是该槽位的凭据值（明文编辑）；缺省表示保持已保存值不变
      const slotValue = entry.value == null ? undefined : String(entry.value)
      return slotValue != null && slotValue !== ''
        ? { id, label, target, name, prefix, value: slotValue }
        : { id, label, target, name, prefix }
    })
  } catch {
    throw new Error(t('skillsMcpUi.credentialSlotsInvalid'))
  }
}

function submit() {
  formError.value = ''
  if (!form.name || (form.transport === 'http' ? !form.endpoint : !form.command)) {
    formError.value = t('skillsMcpUi.fillRequired')
    return
  }
  try {
    const credentialSlots = form.transport === 'http' ? parseCredentialSlots(form.credential_slots_text) : undefined
    // value 单独抽出成 credential_values（信封加密落库）；definitions 不携带明文
    const credentialValues = Object.fromEntries(
      (credentialSlots ?? [])
        .filter((slot): slot is typeof slot & { value: string } => typeof slot.value === 'string' && slot.value !== '')
        .map(slot => [slot.id, slot.value]),
    )
    const slotDefs = (credentialSlots ?? []).map(({ value: _value, ...definition }) => definition)
    emit('save', {
      name: form.name,
      transport: form.transport,
      endpoint: form.transport === 'http' ? form.endpoint : '',
      command: form.transport === 'stdio' ? form.command : '',
      timeout_seconds: form.timeout_seconds,
      tool_allowlist: form.tool_allowlist_text.split(',').map(value => value.trim()).filter(Boolean),
      confirm_mode: form.confirm_mode,
      enabled: form.enabled,
      ...(credentialSlots ? { credential_slots: slotDefs, credential_values: credentialValues } : {}),
    })
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : t('skillsMcpUi.credentialSlotsInvalid')
  }
}
</script>

<style scoped>
.skill-form { position:relative; z-index:1; isolation:isolate; padding:24px; color:var(--content-primary); max-height:calc(100vh - 48px); overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--scrollbar-thumb) transparent; }
.form-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; }.form-head h2 { margin:0; font-size:20px; }.form-head p { margin:6px 0 0; color:var(--content-secondary); font-size:12px; }.form-row { display:grid; grid-template-columns:minmax(0,1fr) 130px; gap:12px; }
.form-field { display:flex; flex-direction:column; gap:6px; margin-top:13px; color:var(--content-secondary); font-size:12px; }.field-label { display:block; line-height:var(--line-height-ui); }.form-field :deep(.select-popup) { width:100%; }.form-field :deep(.select-popup-trigger) { width:100%; }
.form-input { box-sizing:border-box; width:100%; min-height:var(--control-height-md); padding:6px 12px; border:1px solid var(--input-border); border-radius:var(--radius-sm); background:var(--input-bg); color:var(--input-fg); font:var(--font-weight-regular) var(--font-size-body)/var(--line-height-body) var(--font-sans); outline:none; box-shadow:var(--input-hover-shadow); transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }.form-input:hover { background:var(--input-bg-hover); border-color:var(--input-border-hover); }.form-input:focus { background:var(--input-bg-focus); border-color:var(--input-border-focus); box-shadow:var(--input-hover-shadow), var(--input-focus-shadow); }.credential-slots-input { min-height:140px; }.form-hint { margin:6px 0 0; color:var(--content-tertiary); font-size:11px; }.form-error { margin:12px 0 0; color:var(--status-danger); font-size:12px; }
.form-actions { display:flex; align-items:center; gap:10px; margin-top:22px; }.form-action-spacer { flex:1; }
@media (max-width:620px) { .form-row { grid-template-columns:1fr; } }
</style>
