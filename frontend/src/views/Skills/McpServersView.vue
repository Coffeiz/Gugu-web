<template>
  <div class="mcp-page" :aria-busy="loading">
    <div v-if="error" class="error-banner" role="alert">
      {{ error }} <button type="button" @click="retryLoad">{{ t('skills.retry') }}</button>
    </div>

    <template v-if="loaded">
      <div v-if="!items.length" class="empty-state">
        <Icon name="resource.mcp" :size="32" />
        <strong>{{ t('skillsMcpUi.empty') }}</strong>
        <span>{{ t('skillsMcpUi.hint') }}</span>
        <ActionButton fit @click="openChatSetup">{{ t('skillsMcpUi.createFirst') }}</ActionButton>
      </div>
      <div v-else class="mcp-list scroll-surface scroll-surface--compact">
        <McpCard
          v-for="item in items"
          :key="item.id"
          :server="item"
          :busy="busyId === item.id || checkingIds.has(item.id)"
          :status-checking="checkingIds.has(item.id)"
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
    </div>

    <McpServerFormModal
      :key="formKey"
      :show="editor"
      :server="editing"
      :busy="saving"
      :submit-error="formError"
      @close="closeEditor"
      @save="save"
    />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { showAppError, showAppSuccess } from '@/composables/core/useAppToast'
import { useUiStore } from '@/stores/ui'
import { mcpApi, type McpServerItem } from '@/services/api'
import McpCard from './components/McpCard.vue'
import McpServerFormModal from './components/McpServerFormModal.vue'
import type { McpServerDraft } from './components/mcp-types'
import { notifyResourceChanged, RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'
import { useMcpStatusLoader } from './composables/useMcpStatusLoader'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const props = defineProps<{ createRequest?: number }>()
const uiStore = useUiStore()
const loading = ref(false)
const loaded = ref(false)
const saving = ref(false)
const busyId = ref<string | null>(null)
const error = ref('')
const formError = ref('')
const items = ref<McpServerItem[]>([])
const maxServers = ref(5)
const editor = ref(false)
const editing = ref<McpServerItem | null>(null)
const formKey = ref(0)
const statusLoader = useMcpStatusLoader()
const checkingIds = statusLoader.checkingIds
let dispatchingMcpChange = false
let listGeneration = 0

watch(() => props.createRequest, (request, previous) => {
  if (request && request !== previous) openCreate()
})

async function load(refreshMissingStatuses = true) {
  const currentGeneration = ++listGeneration
  statusLoader.cancel()
  loading.value = true
  error.value = ''
  try {
    const result = await mcpApi.list()
    if (currentGeneration !== listGeneration) return
    items.value = result.items
    maxServers.value = result.max_servers
    loaded.value = true
    if (refreshMissingStatuses) {
      void statusLoader.refresh(items.value, (serverId, status) => {
        const server = items.value.find(candidate => candidate.id === serverId)
        if (!server || !server.enabled) return
        server.state = status.state
        server.loaded_tool_count = status.tool_count
        server.loaded_tool_names = status.tool_names ?? []
      })
    }
  } catch (cause) {
    if (currentGeneration === listGeneration) {
      error.value = cause instanceof Error ? cause.message : t('skillsMcpUi.loadFailed')
    }
  } finally {
    if (currentGeneration === listGeneration) loading.value = false
  }
}

function retryLoad() {
  void load()
}

function broadcastMcpChange() {
  // 当前页面已自行刷新列表；只通知侧栏、技能等其他消费者，避免重复触发本页加载。
  dispatchingMcpChange = true
  try {
    notifyResourceChanged('mcp')
  } finally {
    dispatchingMcpChange = false
  }
}

function openCreate() {
  formError.value = ''
  editing.value = null
  formKey.value++
  editor.value = true
}

function openChatSetup() {
  uiStore.pendingChatPrefill = t('skillsMcpUi.configureWithChat')
}

function openEdit(item: McpServerItem) {
  formError.value = ''
  editing.value = item
  formKey.value++
  editor.value = true
}

async function openRequestedServer() {
  const requestedId = typeof route.query.server === 'string' ? route.query.server : ''
  if (!requestedId) return
  if (!loaded.value) await load(false)
  if (!loaded.value) {
    await router.replace({ query: { ...route.query, server: undefined } })
    return
  }
  const target = items.value.find(item => item.id === requestedId)
  if (!target) {
    showAppError(t('skillsMcpUi.targetMissing'))
  } else {
    openEdit(target)
  }
  await router.replace({ query: { ...route.query, server: undefined } })
}

function closeEditor() {
  editor.value = false
  editing.value = null
  formError.value = ''
}

async function save(draft: McpServerDraft) {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  try {
    const payload: Record<string, unknown> = { ...draft }
    // 非当前传输方式的字段不参与保存，避免编辑 HTTP 服务时把空 command
    // 当成有值的 patch 字段提交，触发后端字符串最小长度校验。
    if (draft.transport === 'http') delete payload.command
    else delete payload.endpoint
    const saved = editing.value
      ? await mcpApi.update(editing.value.id, payload)
      : await mcpApi.create(payload)
    broadcastMcpChange()
    let runtime: { ok: boolean; state: string; tool_count: number; tool_names?: string[]; error?: string } | null = null
    if (draft.enabled) {
      runtime = await mcpApi.reconnect(saved.id)
      if (!runtime.ok) showAppError(runtime.error || t('skillsMcpUi.testFailed'))
    }
    closeEditor()
    if (!runtime || runtime.ok) showAppSuccess(t('skillsMcpUi.saved'))
    await load(false)
    const refreshed = items.value.find(candidate => candidate.id === saved.id)
    if (refreshed && runtime) {
      refreshed.state = runtime.state
      refreshed.loaded_tool_count = runtime.tool_count
      refreshed.loaded_tool_names = runtime.tool_names ?? []
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : t('skillsMcpUi.saveFailed')
    formError.value = detail
    showAppError(detail)
  } finally {
    saving.value = false
  }
}

async function test(item: McpServerItem) {
  busyId.value = item.id
  try {
    const result = await mcpApi.test(item.id)
    if (result.ok) showAppSuccess(t('skillsMcpUi.testSuccess', { count: result.tool_count ?? 0 }))
    else showAppError(result.error || t('skillsMcpUi.testFailed'))
    await load(false)
    const refreshed = items.value.find(candidate => candidate.id === item.id)
    if (refreshed) {
      refreshed.state = result.ok ? 'ok' : 'error'
      refreshed.loaded_tool_count = result.tool_count ?? 0
      refreshed.loaded_tool_names = result.tools ?? []
    }
  } catch (cause) {
    showAppError(cause instanceof Error ? cause.message : t('skillsMcpUi.testFailed'))
  } finally {
    busyId.value = null
  }
}

async function reconnect(item: McpServerItem) {
  busyId.value = item.id
  try {
    const result = await mcpApi.reconnect(item.id)
    broadcastMcpChange()
    if (result.ok) showAppSuccess(t('skillsMcpUi.reconnectSuccess', { count: result.tool_count }))
    else showAppError(result.error || t('skillsMcpUi.testFailed'))
    await load(false)
    const refreshed = items.value.find(candidate => candidate.id === item.id)
    if (refreshed) {
      refreshed.state = result.state
      refreshed.loaded_tool_count = result.tool_count
      refreshed.loaded_tool_names = result.tool_names ?? []
    }
  } catch (cause) {
    showAppError(cause instanceof Error ? cause.message : t('skillsMcpUi.testFailed'))
  } finally {
    busyId.value = null
  }
}

async function toggle(item: McpServerItem) {
  busyId.value = item.id
  try {
    await mcpApi.update(item.id, { enabled: !item.enabled })
    broadcastMcpChange()
    if (!item.enabled) {
      const result = await mcpApi.reconnect(item.id)
      if (!result.ok) showAppError(result.error || t('skillsMcpUi.testFailed'))
      await load(false)
      const refreshed = items.value.find(candidate => candidate.id === item.id)
      if (refreshed) {
        refreshed.state = result.state
        refreshed.loaded_tool_count = result.tool_count
        refreshed.loaded_tool_names = result.tool_names ?? []
      }
      return
    }
    await load(false)
  } catch (cause) {
    showAppError(cause instanceof Error ? cause.message : t('skillsMcpUi.saveFailed'))
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
    broadcastMcpChange()
    showAppSuccess(t('skillsMcpUi.deleted'))
    await load(false)
  } catch (cause) {
    showAppError(cause instanceof Error ? cause.message : t('skillsMcpUi.deleteFailed'))
  } finally {
    busyId.value = null
  }
}

const onMcpChanged = () => {
  if (!dispatchingMcpChange) void load()
}
onMounted(() => {
  window.addEventListener(RESOURCE_REFRESH_EVENTS.mcp, onMcpChanged)
  if (typeof route.query.server === 'string') void openRequestedServer()
  else void load()
})
watch(() => route.query.server, () => { void openRequestedServer() })
onBeforeUnmount(() => {
  listGeneration += 1
  statusLoader.cancel()
  window.removeEventListener(RESOURCE_REFRESH_EVENTS.mcp, onMcpChanged)
})
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
.mcp-footer { display:flex; align-items:center; gap:14px; flex-shrink:0; border-top:1px solid var(--content-divider); padding:14px 8px 0; }
.mcp-muted { color:var(--content-secondary); font-size:12px; }
@media (max-width:720px) { .mcp-list { column-count:1; } }
</style>
