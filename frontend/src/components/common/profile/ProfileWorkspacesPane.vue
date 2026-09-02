<template>
  <div class="pm-workspaces-pane">
    <template v-if="shellLoading || globalEnabled">
    <div class="pm-section pm-shell-section">
      <div class="pm-section-label">{{ t('profileWorkspacesUi.shellAccess') }}</div>
      <p class="pm-workspaces-intro">{{ t('profileWorkspacesUi.shellIntro') }}</p>
      <div v-if="shellLoading" class="pm-workspaces-empty">{{ t('profileWorkspacesUi.loadingShell') }}</div>
      <template v-else-if="sandboxEnabled && globalEnabled">
        <div class="pm-tool-rows">
          <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileWorkspacesUi.shellSandbox') }}</span><span class="pm-field-hint">{{ t('profileWorkspacesUi.shellSandboxHint') }}</span></div><ToggleSwitch :model-value="prefsStore.shellEnabled" :aria-label="t('profileWorkspacesUi.toggleShellSandbox')" @update:model-value="prefsStore.saveShellEnabled($event)" /></div>
          <div v-if="systemGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileWorkspacesUi.systemShell') }}</span><span class="pm-field-hint">{{ t('profileWorkspacesUi.systemShellHint') }}</span></div><ToggleSwitch :model-value="prefsStore.shellSystemEnabled" :aria-label="t('profileWorkspacesUi.toggleSystemShell')" @update:model-value="prefsStore.saveShellSystemEnabled($event)" /></div>
          <div v-if="dangerousGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileWorkspacesUi.dangerousShell') }}</span><span class="pm-field-hint">{{ t('profileWorkspacesUi.dangerousShellHint') }}</span></div><ToggleSwitch :model-value="prefsStore.shellDangerousEnabled" :aria-label="t('profileWorkspacesUi.toggleDangerousShell')" @update:model-value="prefsStore.saveShellDangerousEnabled($event)" /></div>
          <div v-if="autopilotGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">Shell Autopilot</span><span class="pm-field-hint">{{ t('profileWorkspacesUi.autopilotHint') }}</span></div><ToggleSwitch :model-value="prefsStore.shellAutopilotEnabled" :aria-label="t('profileWorkspacesUi.toggleAutopilot')" @update:model-value="prefsStore.saveShellAutopilotEnabled($event)" /></div>
        </div>
        <div class="pm-shell-reset-row">
          <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileWorkspacesUi.resetTerminalEnvironment') }}</span><span class="pm-field-hint">{{ t('profileWorkspacesUi.resetTerminalHint') }}</span></div>
          <div class="pm-shell-actions">
            <button class="pm-shell-reset" type="button" :disabled="resetting || rebuilding" @click="resetShellEnvironments"><Icon name="action.refresh" size="sm" tone="inherit" />{{ resetting ? t('profileWorkspacesUi.resetting') : t('profileWorkspacesUi.resetTerminal') }}</button>
            <button class="pm-shell-reset" type="button" :disabled="resetting || rebuilding" @click="rebuildShell"><Icon name="action.refresh" size="sm" tone="inherit" />{{ rebuilding ? t('profileWorkspacesUi.rebuilding') : t('profileWorkspacesUi.rebuildSandbox') }}</button>
          </div>
        </div>
        <p v-if="shellMessage" class="pm-msg" :class="shellMessageType">{{ shellMessage }}</p>
      </template>
      <div v-else class="pm-workspaces-empty">{{ t('profileWorkspacesUi.shellDisabled') }}</div>
    </div>
    <div class="pm-sep"></div>
    </template>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('profileWorkspacesUi.workspaceManagement') }}</div>
      <p class="pm-workspaces-intro">{{ t('profileWorkspacesUi.workspaceIntro') }}</p>
      <div v-if="loading" class="pm-workspaces-empty">{{ t('profileWorkspacesUi.loadingWorkspaces') }}</div>
      <div v-else-if="items.length === 0" class="pm-workspaces-empty">{{ t('profileWorkspacesUi.noWorkspaces') }}</div>
      <div v-else class="pm-workspace-list">
        <div v-for="item in items" :key="item.id" class="pm-workspace-card">
          <div class="pm-workspace-main">
            <div class="pm-workspace-title-row">
              <Icon :name="item.kind === 'project' ? 'admin.folders' : 'admin.folder'" size="sm" tone="inherit" />
              <input v-if="editingId === item.id" v-model="editingName" class="pm-workspace-input" maxlength="200" @keyup.enter="saveName(item)" @keyup.esc="cancelEdit" />
              <span v-else class="pm-workspace-name">{{ item.name }}</span>
              <span v-if="item.isDefault" class="pm-workspace-badge">{{ t('profileWorkspacesUi.default') }}</span>
            </div>
            <div class="pm-workspace-meta">{{ item.kind === 'project' ? t('profileWorkspacesUi.project') : t('profileWorkspacesUi.folder') }} · {{ t('profileWorkspacesUi.sessionBindings', { count: item.boundSessionCount }) }}</div>
          </div>
          <div class="pm-workspace-actions">
            <button v-if="editingId === item.id" class="pm-workspace-action" :title="t('profileWorkspacesUi.saveName')" :disabled="savingId === item.id" @click="saveName(item)"><Icon name="status.success" size="sm" tone="inherit" /></button>
            <button v-else class="pm-workspace-action" :title="t('sharedUi.rename')" @click="startEdit(item)"><Icon name="action.edit" size="sm" tone="inherit" /></button>
            <button class="pm-workspace-action danger" :title="t('profileWorkspacesUi.deleteWorkspace')" :disabled="savingId === item.id" @click="remove(item)"><Icon name="action.delete" size="sm" tone="inherit" /></button>
          </div>
        </div>
      </div>
      <p v-if="error" class="pm-msg err">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import { agentApi, terminalsApi, workspacesApi } from '@/services/api'
import { usePreferencesStore } from '@/stores/preferences'
import { useLiveStore } from '@/stores/live'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { confirmDialog } from '@/composables/useConfirmDialog'

type WorkspaceItem = {
  id: number
  name: string
  kind: 'folder' | 'project'
  enabled: boolean
  isDefault: boolean
  boundSessionCount: number
}

const items = ref<WorkspaceItem[]>([])
const loading = ref(true)
const error = ref('')
const shellLoading = ref(true)
const sandboxEnabled = ref(false)
const globalEnabled = ref(false)
const systemGlobalEnabled = ref(false)
const dangerousGlobalEnabled = ref(false)
const autopilotGlobalEnabled = ref(false)
const resetting = ref(false)
const rebuilding = ref(false)
const shellMessage = ref('')
const shellMessageType = ref<'ok' | 'err'>('ok')
const prefsStore = usePreferencesStore()
const liveStore = useLiveStore()
const { t } = useI18n()
const editingId = ref<number | null>(null)
const editingName = ref('')
const savingId = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await workspacesApi.status()
    sandboxEnabled.value = response.sandboxEnabled === true
    globalEnabled.value = response.globalEnabled
    systemGlobalEnabled.value = response.systemGlobalEnabled
    dangerousGlobalEnabled.value = response.dangerousGlobalEnabled
    autopilotGlobalEnabled.value = response.autopilotGlobalEnabled === true
    items.value = response.items as WorkspaceItem[]
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileWorkspacesUi.workspaceLoadFailed')
  } finally {
    loading.value = false
    shellLoading.value = false
  }
}

async function resetShellEnvironments() {
  if (resetting.value) return
  const confirmed = await confirmDialog({ title: t('profileWorkspacesUi.resetShellTitle'), message: t('profileWorkspacesUi.resetShellMessage'), tone: 'warning', confirmText: t('profileWorkspacesUi.resetEnvironment') })
  if (!confirmed) return
  resetting.value = true
  shellMessage.value = ''
  try {
    const response = await terminalsApi.list()
    const results = await Promise.allSettled(response.items.map(item => terminalsApi.reset(item.id)))
    const failed = results.filter(result => result.status === 'rejected').length
    shellMessageType.value = failed > 0 ? 'err' : 'ok'
    shellMessage.value = failed > 0 ? t('profileWorkspacesUi.resetSummaryFailed', { success: response.items.length - failed, failed }) : response.items.length > 0 ? t('profileWorkspacesUi.resetSummary', { count: response.items.length }) : t('profileWorkspacesUi.noTerminalsToReset')
  } catch (cause) {
    shellMessageType.value = 'err'
    shellMessage.value = cause instanceof Error ? cause.message : t('profileWorkspacesUi.resetFailed')
  } finally {
    resetting.value = false
  }
}

async function rebuildShell() {
  if (rebuilding.value) return
  const confirmed = await confirmDialog({ title: t('profileWorkspacesUi.rebuildTitle'), message: t('profileWorkspacesUi.rebuildMessage'), tone: 'warning', confirmText: t('profileWorkspacesUi.rebuildSandbox') })
  if (!confirmed) return
  rebuilding.value = true
  shellMessage.value = ''
  try {
    const result = await agentApi.rebuildSandbox()
    shellMessageType.value = 'ok'
    shellMessage.value = result.reclaimed_containers > 0 ? t('profileWorkspacesUi.reclaimedContainers', { count: result.reclaimed_containers }) : t('profileWorkspacesUi.noRunningContainers')
  } catch (cause) {
    shellMessageType.value = 'err'
    shellMessage.value = cause instanceof Error ? cause.message : t('profileWorkspacesUi.rebuildFailed')
  } finally {
    rebuilding.value = false
  }
}

function startEdit(item: WorkspaceItem) {
  editingId.value = item.id
  editingName.value = item.name
  error.value = ''
}
function cancelEdit() {
  editingId.value = null
  editingName.value = ''
}

async function saveName(item: WorkspaceItem) {
  const name = editingName.value.trim()
  if (!name || savingId.value !== null) return
  savingId.value = item.id
  try {
    const response = await workspacesApi.update(item.id, { name }) as WorkspaceItem
    Object.assign(item, response)
    cancelEdit()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileWorkspacesUi.renameFailed')
  } finally {
    savingId.value = null
  }
}

async function remove(item: WorkspaceItem) {
  if (savingId.value !== null) return
  const confirmed = await confirmDialog({ title: t('profileWorkspacesUi.deleteWorkspace'), message: t('profileWorkspacesUi.deleteMessage', { name: item.name }), tone: 'danger', confirmText: t('profileWorkspacesUi.deleteWorkspace') })
  if (!confirmed) return
  savingId.value = item.id
  try {
    await workspacesApi.delete(item.id)
    items.value = items.value.filter(current => current.id !== item.id)
    if (editingId.value === item.id) cancelEdit()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileWorkspacesUi.deleteFailed')
  } finally {
    savingId.value = null
  }
}

onMounted(load)
watch(() => liveStore.resourceEvent, (event) => {
  if (event?.resource === 'terminals' && event.operation === 'refresh') {
    void load()
  }
})
</script>

<style>
.pm-workspaces-intro { margin: -4px 0 16px; color: var(--content-secondary); font-size: 12px; line-height: 1.6; }
.pm-workspace-list { display: flex; flex-direction: column; gap: 10px; }
.pm-workspace-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 14px; border: 1px solid var(--workspace-card-border); border-radius: var(--radius-md); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.pm-workspace-card:hover { border-color: var(--theme-action-primary); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); }
.pm-workspace-main { min-width: 0; }
.pm-workspace-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--content-primary); }
.pm-workspace-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 650; }
.pm-workspace-input { min-width: 0; width: min(360px, 100%); box-sizing: border-box; height: var(--rename-input-height); padding: var(--rename-input-padding); border: 1px solid var(--rename-input-border); border-radius: var(--rename-input-radius); outline: none; background: var(--rename-input-bg); color: var(--rename-input-fg); font: var(--font-size-sm) var(--font-sans); line-height: var(--rename-input-height); box-shadow: var(--input-hover-shadow), 0 0 0 0 transparent; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.pm-workspace-input:hover { border-color: var(--input-border-hover); background: var(--input-bg-hover); box-shadow: var(--input-hover-shadow), 0 0 0 0 transparent; }
.pm-workspace-input:focus { border-color: var(--input-border-focus); background: var(--input-bg-focus); box-shadow: var(--input-hover-shadow), var(--input-focus-shadow); }
.pm-workspace-meta { margin-top: 5px; color: var(--content-secondary); font-size: 12px; }
.pm-workspace-badge { flex: 0 0 auto; padding: 2px 7px; border-radius: var(--radius-pill); background: var(--workspace-badge-bg); color: var(--workspace-badge-fg); font-size: 11px; }
.pm-workspace-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
.pm-workspace-action { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--content-secondary); cursor: pointer; transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard); }
.pm-workspace-action:hover:not(:disabled) { background: var(--sidebar-item-hover); color: var(--content-primary); }
.pm-workspace-action.danger:hover:not(:disabled) { background: var(--danger-button-bg); color: var(--danger-button-fg); }
.pm-workspace-action:disabled { cursor: wait; opacity: .5; }
.pm-workspaces-empty { padding: 24px 0; color: var(--content-secondary); font-size: 13px; text-align: center; }
.pm-tool-rows { display: flex; flex-direction: column; gap: 14px; }
.pm-shell-reset-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--panel-divider); }
.pm-shell-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.pm-shell-reset { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto; min-height: 32px; padding: 0 11px; border: 1px solid var(--control-border); border-radius: var(--radius-sm); background: var(--control-bg); color: var(--content-secondary); font: inherit; font-size: 12px; cursor: pointer; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard); }
.pm-shell-reset:hover:not(:disabled) { border-color: var(--control-border-hover); background: var(--control-bg-hover); color: var(--content-primary); }
.pm-shell-reset:disabled { cursor: wait; opacity: .55; }
@media (max-width: 560px) { .pm-shell-reset-row { align-items: flex-start; flex-direction: column; } .pm-shell-actions { width: 100%; } .pm-shell-reset { flex: 1; } }
</style>
