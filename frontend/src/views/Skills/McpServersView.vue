<template>
  <div class="mcp-page" :aria-busy="loading">
    <header class="section-header">
      <ActionButton fit :disabled="items.length >= maxServers" @click="openCreate">
        <Icon name="action.add" :size="14" />{{ t('skillsMcpUi.add') }}
      </ActionButton>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      {{ error }} <button type="button" @click="load">{{ t('skills.retry') }}</button>
    </div>

    <template v-if="loaded">
      <div v-if="!items.length" class="empty-state">
        <Icon name="resource.skill" :size="32" />
        <strong>{{ t('skillsMcpUi.empty') }}</strong>
        <span>{{ t('skillsMcpUi.hint') }}</span>
        <ActionButton fit :disabled="items.length >= maxServers" @click="openCreate">{{ t('skillsMcpUi.add') }}</ActionButton>
      </div>
      <div v-else class="mcp-list scroll-surface scroll-surface--compact">
        <McpCard
          v-for="item in items"
          :key="item.id"
          :server="item"
          :busy="busyId === item.id"
          @toggle="toggle"
          @test="test"
          @reconnect="reconnect"
          @edit="openEdit"
          @remove="remove"
        />
      </div>
    </template>

    <div v-if="loaded && items.length && !editor" class="mcp-footer">
      <span class="mcp-muted">{{ t('skillsMcpUi.limit', { count: maxServers }) }}</span>
      <span v-if="message" class="mcp-message" :class="messageType" role="status">{{ message }}</span>
    </div>
    <div v-else-if="loaded && message && !editor" class="mcp-message" :class="messageType" role="status">{{ message }}</div>

    <McpServerFormModal
      v-if="editor"
      :key="formKey"
      :show="editor"
      :server="editing"
      :busy="saving"
      @close="closeEditor"
      @save="save"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { mcpApi, type McpServerItem } from '@/services/api'
import McpCard from './components/McpCard.vue'
import McpServerFormModal from './components/McpServerFormModal.vue'
import type { McpServerDraft } from './components/mcp-types'

const { t } = useI18n()
const loading = ref(false)
const loaded = ref(false)
const saving = ref(false)
const busyId = ref<string | null>(null)
const error = ref('')
const message = ref('')
const messageType = ref<'ok' | 'err'>('ok')
const items = ref<McpServerItem[]>([])
const maxServers = ref(5)
const editor = ref(false)
const editing = ref<McpServerItem | null>(null)
const formKey = ref(0)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await mcpApi.list()
    items.value = result.items
    maxServers.value = result.max_servers
    loaded.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('skillsMcpUi.loadFailed')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  message.value = ''
  editing.value = null
  formKey.value++
  editor.value = true
}

function openEdit(item: McpServerItem) {
  message.value = ''
  editing.value = item
  formKey.value++
  editor.value = true
}

function closeEditor() {
  editor.value = false
  editing.value = null
}

async function save(draft: McpServerDraft) {
  if (saving.value) return
  saving.value = true
  message.value = ''
  try {
    if (editing.value) await mcpApi.update(editing.value.id, { ...draft })
    else await mcpApi.create({ ...draft })
    closeEditor()
    message.value = t('skillsMcpUi.saved')
    messageType.value = 'ok'
    await load()
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : t('skillsMcpUi.saveFailed')
    messageType.value = 'err'
  } finally {
    saving.value = false
  }
}

async function test(item: McpServerItem) {
  busyId.value = item.id
  message.value = ''
  try {
    const result = await mcpApi.test(item.id)
    message.value = result.ok ? t('skillsMcpUi.testSuccess', { count: result.tool_count ?? 0 }) : (result.error || t('skillsMcpUi.testFailed'))
    messageType.value = result.ok ? 'ok' : 'err'
    await load()
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : t('skillsMcpUi.testFailed')
    messageType.value = 'err'
  } finally {
    busyId.value = null
  }
}

async function reconnect(item: McpServerItem) {
  busyId.value = item.id
  message.value = ''
  try {
    const result = await mcpApi.reconnect(item.id)
    message.value = result.ok ? t('skillsMcpUi.reconnectSuccess', { count: result.tool_count }) : (result.error || t('skillsMcpUi.testFailed'))
    messageType.value = result.ok ? 'ok' : 'err'
    await load()
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : t('skillsMcpUi.testFailed')
    messageType.value = 'err'
  } finally {
    busyId.value = null
  }
}

async function toggle(item: McpServerItem) {
  busyId.value = item.id
  try {
    await mcpApi.update(item.id, { enabled: !item.enabled })
    await load()
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : t('skillsMcpUi.saveFailed')
    messageType.value = 'err'
  } finally {
    busyId.value = null
  }
}

async function remove(item: McpServerItem) {
  if (!await confirmDialog({
    title: t('skillsMcpUi.deleteTitle'),
    message: t('skillsMcpUi.deleteMessage', { name: item.name }),
    tone: 'danger',
    confirmText: t('skillsMcpUi.delete'),
  })) return

  busyId.value = item.id
  try {
    await mcpApi.remove(item.id)
    message.value = t('skillsMcpUi.deleted')
    messageType.value = 'ok'
    await load()
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : t('skillsMcpUi.deleteFailed')
    messageType.value = 'err'
  } finally {
    busyId.value = null
  }
}

onMounted(load)
</script>

<style scoped>
.mcp-page { min-height:0; height:100%; display:flex; flex-direction:column; }
.section-header { display:flex; align-items:center; justify-content:flex-start; gap:20px; margin-bottom:16px; flex-shrink:0; }
.mcp-list { flex:1; min-height:0; overflow-y:auto; column-count:2; column-gap:12px; margin:0 -8px; padding:10px 8px 16px; }
.mcp-list :deep(.skill-card) { margin:0 0 12px; }
.empty-state { min-height:300px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--content-secondary); }
.empty-state strong { color:var(--content-primary); }.empty-state span { max-width:420px; font-size:12px; text-align:center; }
.error-banner { padding:10px 12px; border-radius:var(--radius-sm); color:var(--danger-fg); background:var(--danger-bg); font-size:12px; margin-bottom:12px; }
.error-banner button { margin-left:10px; border:0; background:transparent; color:inherit; cursor:pointer; }
.mcp-footer { display:flex; align-items:center; gap:14px; flex-shrink:0; border-top:1px solid var(--border-default); padding:14px 8px 0; }
.mcp-muted, .mcp-message { color:var(--content-secondary); font-size:12px; }.mcp-message { margin-top:12px; }.mcp-footer .mcp-message { margin:0; }.mcp-message.ok { color:var(--status-success); }.mcp-message.err { color:var(--status-danger); }
@media (max-width:720px) { .mcp-list { column-count:1; } }
</style>
