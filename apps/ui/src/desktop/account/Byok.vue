<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { desktopRemoteByok } from '@desktop/bridge/bridge'
import type { ByokCommand, ByokSummary } from '@gugu/core/byok/contracts'

const props = defineProps({ origin: { type: String, required: true }, accountId: { type: String, required: true } })
const { t } = useI18n()
const capabilities = computed(() => [
  { value: 'llm', label: t('pageUi.dialogue') },
  { value: 'embedding', label: t('pageUi.embedding') },
  { value: 'speech_to_text', label: t('pageUi.speechRecognition') },
  { value: 'deep_research', label: t('pageUi.deepResearch') },
  { value: 'similar_image_search', label: t('pageUi.similarImageSearch') },
])
type Draft = Extract<ByokCommand, { action: 'create' }>['input']
const blank = (): Draft => ({ capability: 'llm', provider: '', api_format: '', base_url: '', model: '', value: '' })
const draft = reactive(blank())
const editing = ref<number | null>(null)
const items = ref<ByokSummary[]>([])
const ready = ref(false)
const busy = ref(false)
const message = ref('')
const error = ref('')
const needsReconfigure = ref(false)

function request(command: ByokCommand) {
  return desktopRemoteByok({ origin: props.origin, accountId: props.accountId }, command)
}

async function refresh() {
  const result = await request({ action: 'list' })
  if (!result || !('items' in result)) throw new Error(t('pageUi.missingCredentialList'))
  items.value = result.items
  needsReconfigure.value = result.status === 'needs_reconfigure'
  ready.value = true
}

async function perform(operation: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try { await operation() } catch (reason) {
    error.value = reason instanceof Error ? reason.message : t('pageUi.credentialOperationFailed')
  } finally { busy.value = false }
}

function edit(item?: ByokSummary) {
  editing.value = item?.id ?? null
  Object.assign(draft, blank(), item && {
    capability: item.capability, provider: item.provider, api_format: item.api_format,
    base_url: item.base_url, model: item.model,
  })
}

function setCapability(value: string) {
  switch (value) {
    case 'llm':
    case 'embedding':
    case 'speech_to_text':
    case 'deep_research':
    case 'similar_image_search':
      draft.capability = value
  }
}

function save() {
  void perform(async () => {
    const { capability, value, ...fields } = draft
    draft.value = ''
    await request(editing.value === null
      ? { action: 'create', input: { capability, value, ...fields } }
      : { action: 'update', id: editing.value, input: { ...fields, ...(value ? { value } : {}) } })
    edit()
    await refresh()
    message.value = t('pageUi.credentialSaved')
  })
}

function test(item: ByokSummary) {
  void perform(async () => {
    const result = await request({ action: 'test', id: item.id })
    if (!result || !('ok' in result) || !result.ok) throw new Error(t('pageUi.connectionTestFailed'))
    message.value = t('pageUi.connectionTestPassed')
  })
}

function remove(item: ByokSummary) {
  void perform(async () => {
    if (!await confirmDialog({
      title: t('desktopByok.deleteTitle'), message: t('desktopByok.deleteMessage'),
      confirmText: t('desktopByok.deleteTitle'), tone: 'danger',
    })) return
    await request({ action: 'delete', id: item.id })
    if (editing.value === item.id) edit()
    await refresh()
    message.value = t('pageUi.credentialDeleted')
  })
}

onMounted(() => void perform(refresh))
</script>

<template>
  <section class="byok">
    <h2>{{ $t('pageUi.serverModels') }}</h2>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="needsReconfigure" role="status">{{ $t('pageUi.missingKeys') }}</p>
    <ActionButton v-if="!ready" fit :disabled="busy" @click="perform(refresh)">{{ busy ? $t('pageUi.reading') : $t('pageUi.reload') }}</ActionButton>
    <template v-else>
      <ul v-if="items.length" class="items">
        <li v-for="item in items" :key="item.id">
          <strong>{{ item.provider }} {{ item.model }}</strong>
          <span>{{ capabilities.find(entry => entry.value === item.capability)?.label }}</span>
          <div class="actions">
            <ActionButton fit variant="secondary" :disabled="busy" @click="edit(item)">{{ $t('pageUi.edit') }}</ActionButton>
            <ActionButton fit variant="secondary" :disabled="busy" @click="test(item)">{{ $t('pageUi.test') }}</ActionButton>
            <ActionButton fit variant="secondary" :disabled="busy" @click="remove(item)">{{ t('desktopByok.deleteTitle') }}</ActionButton>
          </div>
        </li>
      </ul>
      <form @submit.prevent="save">
        <h3>{{ editing === null ? $t('pageUi.addCredential') : $t('pageUi.editCredential') }}</h3>
        <label>{{ $t('pageUi.capabilities') }} <SelectPopup :model-value="draft.capability" @update:model-value="setCapability" :options="capabilities" :disabled="busy || editing !== null" /></label>
        <label>{{ $t('pageUi.provider') }} <input v-model.trim="draft.provider" required maxlength="64" :disabled="busy"></label>
        <label>{{ $t('pageUi.apiFormat') }} <input v-model.trim="draft.api_format" maxlength="32" :disabled="busy"></label>
        <label>{{ $t('pageUi.baseUrl') }} <input v-model.trim="draft.base_url" type="url" maxlength="500" :disabled="busy"></label>
        <label>{{ $t('pageUi.model') }} <input v-model.trim="draft.model" maxlength="200" :disabled="busy"></label>
        <label>{{ $t('pageUi.apiKey') }} <input v-model="draft.value" type="password" maxlength="20000" autocomplete="new-password" :disabled="busy" :placeholder="editing === null ? '' : $t('pageUi.keepKey')"></label>
        <div class="actions">
          <ActionButton fit type="submit" :disabled="busy">{{ $t('common.actions.save') }}</ActionButton>
          <ActionButton v-if="editing !== null" fit variant="secondary" :disabled="busy" @click="edit()">{{ $t('pageUi.cancelEdit') }}</ActionButton>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.byok { display: grid; gap: 12px; margin-top: 24px; min-width: 0; }
.byok h2, .byok h3, .byok p { margin: 0; }
.byok form, .byok label, .items, .items li { display: grid; gap: 8px; }
.items { padding: 0; margin: 0; list-style: none; }
.items li { padding-block: 8px; overflow-wrap: anywhere; }
.items span { color: var(--text-secondary); }
.byok input { min-height: 36px; padding-inline: 10px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
