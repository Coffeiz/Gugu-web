<template>
  <div class="pm-section personality-preference">
    <div class="pm-section-label">人格偏好</div>
    <div v-if="!prefsStore.personalityPreferenceAvailable" class="personality-locked">用户人格偏好当前未开放，已保存内容不会被删除。</div>
    <template v-else>
      <div class="personality-heading">
        <div class="pm-field-desc">
          <span class="pm-field-name">persona.md</span>
          <span class="pm-field-hint">上传或编辑你的 Markdown 人格文件，文件保存在用户目录的隐藏人格目录中。</span>
        </div>
        <div class="personality-toggle">
          <ToggleSwitch :model-value="enabled" :disabled="saving || !hasContent" aria-label="启用人格偏好" @update:model-value="onToggle" />
          <span class="personality-enabled-label">{{ enabled ? '已启用' : '未启用' }}</span>
        </div>
      </div>
      <div class="personality-file-card">
        <div class="personality-file-icon">MD</div>
        <div class="personality-file-info">
          <div class="personality-file-name">persona.md</div>
          <div class="personality-file-meta">{{ hasContent ? `${characterCount} 个字符` : '尚未创建' }} · 不会出现在文件库</div>
        </div>
        <div class="personality-file-actions">
          <input ref="fileInput" class="personality-file-input" type="file" accept=".md,text/markdown" @change="onFileSelected" />
          <button type="button" class="pm-text-button" :disabled="saving" @click="fileInput?.click()">上传</button>
          <button type="button" class="pm-text-button" :disabled="saving" @click="openEditor">编辑</button>
        </div>
      </div>
      <div v-if="error || status" class="personality-status" :class="{ error: !!error }">{{ error || status }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { usePreviewStore } from '@/stores/preview'

const prefsStore = usePreferencesStore()
const previewStore = usePreviewStore()
const enabled = ref(false)
const saving = ref(false)
const status = ref('')
const error = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const hasContent = computed(() => !!prefsStore.personalityPreference.trim())
const characterCount = computed(() => Array.from(prefsStore.personalityPreference).length)

function syncFromStore() { enabled.value = prefsStore.personalityPreferenceEnabled }
function openEditor() {
  status.value = ''; error.value = ''
  previewStore.openVirtual(
    { id: -1, displayName: 'persona', ext: 'MD', size: `${characterCount.value} 字符` },
    prefsStore.personalityPreference,
    saveDocument,
  )
}

async function saveDocument(content: string) {
  await prefsStore.savePersonalityPreference(content, enabled.value)
  status.value = '已保存，下一轮对话生效'
  error.value = ''
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  saving.value = true; status.value = ''; error.value = ''
  try {
    await prefsStore.uploadPersonalityFile(file)
    status.value = '已上传，可继续编辑'
    openEditor()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '上传失败，请稍后重试'
  } finally { saving.value = false }
}

async function onToggle(value: boolean) {
  const previous = enabled.value
  enabled.value = value; saving.value = true; status.value = ''; error.value = ''
  try {
    await prefsStore.savePersonalityPreference(prefsStore.personalityPreference, value)
    status.value = value ? '人格偏好已启用' : '人格偏好已停用'
  } catch (err) {
    enabled.value = previous
    error.value = err instanceof Error ? err.message : '保存失败，请稍后重试'
  } finally { saving.value = false }
}

onMounted(async () => { if (!prefsStore.loaded) await prefsStore.fetch(); syncFromStore() })
</script>

<style scoped>
.personality-preference { gap: 12px; }
.personality-locked { padding: 10px 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--content-secondary); font-size: 12px; line-height: 1.6; }
.personality-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.personality-toggle { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.personality-file-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 14px; border: 1px solid var(--workspace-card-border); border-radius: var(--radius-md); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.personality-file-card:hover { border-color: var(--theme-action-primary); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); }
.personality-file-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--action-soft); color: var(--action-primary); font: 700 10px var(--font-family-mono); }
.personality-file-info { min-width: 0; flex: 1; }
.personality-file-name { color: var(--content-primary); font-size: 13px; font-weight: 600; }
.personality-file-meta { margin-top: 3px; color: var(--content-tertiary); font-size: 11px; }
.personality-file-actions { display: flex; align-items: center; gap: 4px; }
.personality-file-input { display: none; }
.personality-enabled-label, .personality-status { color: var(--content-secondary); font-size: 12px; }
.personality-status { padding: 2px 0; color: var(--status-success); }
.personality-status.error { color: var(--status-danger); }
.pm-text-button { padding: 6px 8px; border: 0; background: transparent; color: var(--content-secondary); font: 12px var(--font-sans); cursor: pointer; }
.pm-text-button:hover:not(:disabled) { color: var(--content-primary); }
.pm-text-button:disabled { opacity: .45; cursor: default; }
</style>
