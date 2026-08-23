<template>
  <div class="pm-workspaces-pane">
    <div class="pm-section">
      <div class="pm-section-label">工作区管理</div>
      <p class="pm-workspaces-intro">管理已创建的工作区。删除工作区只会解除会话绑定，不会删除对应的文件夹或项目。</p>
      <div v-if="loading" class="pm-workspaces-empty">正在读取工作区…</div>
      <div v-else-if="items.length === 0" class="pm-workspaces-empty">还没有工作区</div>
      <div v-else class="pm-workspace-list">
        <div v-for="item in items" :key="item.id" class="pm-workspace-card">
          <div class="pm-workspace-main">
            <div class="pm-workspace-title-row">
              <Icon :name="item.kind === 'project' ? 'admin.folders' : 'admin.folder'" size="sm" tone="inherit" />
              <input v-if="editingId === item.id" v-model="editingName" class="pm-workspace-input" maxlength="200" @keyup.enter="saveName(item)" @keyup.esc="cancelEdit" />
              <span v-else class="pm-workspace-name">{{ item.name }}</span>
              <span v-if="item.isDefault" class="pm-workspace-badge">默认</span>
            </div>
            <div class="pm-workspace-meta">{{ item.kind === 'project' ? '项目' : '文件夹' }} · {{ item.boundSessionCount }} 个会话绑定</div>
          </div>
          <div class="pm-workspace-actions">
            <button v-if="editingId === item.id" class="pm-workspace-action" title="保存名称" :disabled="savingId === item.id" @click="saveName(item)"><Icon name="status.success" size="sm" tone="inherit" /></button>
            <button v-else class="pm-workspace-action" title="重命名" @click="startEdit(item)"><Icon name="action.edit" size="sm" tone="inherit" /></button>
            <button class="pm-workspace-action danger" title="删除工作区" :disabled="savingId === item.id" @click="remove(item)"><Icon name="action.delete" size="sm" tone="inherit" /></button>
          </div>
        </div>
      </div>
      <p v-if="error" class="pm-msg err">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { workspacesApi } from '@/services/api'
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
const editingId = ref<number | null>(null)
const editingName = ref('')
const savingId = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await workspacesApi.status()
    items.value = response.items as WorkspaceItem[]
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '工作区读取失败'
  } finally {
    loading.value = false
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
    error.value = cause instanceof Error ? cause.message : '工作区重命名失败'
  } finally {
    savingId.value = null
  }
}

async function remove(item: WorkspaceItem) {
  if (savingId.value !== null) return
  const confirmed = await confirmDialog({ title: '删除工作区', message: `确认删除工作区“${item.name}”？\n只会解除会话绑定，不会删除文件或项目。`, tone: 'danger', confirmText: '删除工作区' })
  if (!confirmed) return
  savingId.value = item.id
  try {
    await workspacesApi.delete(item.id)
    items.value = items.value.filter(current => current.id !== item.id)
    if (editingId.value === item.id) cancelEdit()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '工作区删除失败'
  } finally {
    savingId.value = null
  }
}

onMounted(load)
</script>

<style>
.pm-workspaces-intro { margin: -4px 0 16px; color: var(--content-secondary); font-size: 12px; line-height: 1.6; }
.pm-workspace-list { display: flex; flex-direction: column; gap: 10px; }
.pm-workspace-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 14px; border: 1px solid var(--workspace-card-border); border-radius: var(--radius-md); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.pm-workspace-card:hover { border-color: var(--workspace-card-border-hover); background: var(--workspace-card-bg-hover); box-shadow: var(--workspace-card-shadow-hover); }
.pm-workspace-main { min-width: 0; }
.pm-workspace-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--content-primary); }
.pm-workspace-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 650; }
.pm-workspace-input { min-width: 0; width: min(360px, 100%); box-sizing: border-box; padding: 0 var(--space-sm); min-height: var(--control-height-sm); border: 1px solid var(--input-border); border-radius: var(--input-radius); outline: none; background: var(--input-bg); color: var(--input-fg); font: var(--font-size-sm) var(--font-sans); line-height: var(--line-height-ui); transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.pm-workspace-input:hover { border-color: var(--input-border-hover); background: var(--input-bg-hover); }
.pm-workspace-input:focus { border-color: var(--input-border-focus); background: var(--input-bg-focus); box-shadow: var(--input-focus-shadow); }
.pm-workspace-meta { margin-top: 5px; color: var(--content-secondary); font-size: 12px; }
.pm-workspace-badge { flex: 0 0 auto; padding: 2px 7px; border-radius: var(--radius-pill); background: var(--workspace-badge-bg); color: var(--workspace-badge-fg); font-size: 11px; }
.pm-workspace-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
.pm-workspace-action { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--content-secondary); cursor: pointer; transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard); }
.pm-workspace-action:hover:not(:disabled) { background: var(--sidebar-item-hover); color: var(--content-primary); }
.pm-workspace-action.danger:hover:not(:disabled) { background: var(--danger-button-bg); color: var(--danger-button-fg); }
.pm-workspace-action:disabled { cursor: wait; opacity: .5; }
.pm-workspaces-empty { padding: 24px 0; color: var(--content-secondary); font-size: 13px; text-align: center; }
</style>
