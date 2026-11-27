<script setup lang="ts">
import { computed, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { PERSONAL_WORKSPACE_ID } from '@gugu/core/agent/commands/menu'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import type { ChatWorkspaceAccess } from './chatTypes'

const props = defineProps({
  sessionId: { type: Number, required: true },
  name: { type: String, required: true },
  access: { type: Object as PropType<ChatWorkspaceAccess>, required: true },
  disabled: Boolean,
})
const emit = defineEmits<{ change: [id: number, name: string | null] }>()
const { t } = useI18n()
const rows = ref<Awaited<ReturnType<ChatWorkspaceAccess['list']>>>([])
const loading = ref(false)
const saving = ref(false)
const options = computed(() => [
  { value: PERSONAL_WORKSPACE_ID, label: t('filesUi.personalFiles'), icon: 'user.default' },
  ...rows.value.map(row => ({ value: String(row.id), label: row.name, icon: 'file.folder-chart' })),
])

const selectedOption = computed(() => options.value.find(option => option.label === props.name))
const selectedIcon = computed(() => selectedOption.value?.icon ?? 'file.folder-chart')

async function refresh() {
  if (loading.value) return
  loading.value = true
  try { rows.value = await props.access.list(props.sessionId) }
  catch (error) { showAppError(errorMessage(error)) }
  finally { loading.value = false }
}

async function select(value: string) {
  if (saving.value || props.disabled) return
  const id = props.sessionId
  const row = rows.value.find(item => String(item.id) === value)
  if (!row && value !== PERSONAL_WORKSPACE_ID) return
  saving.value = true
  try {
    await props.access.select(id, row?.id ?? PERSONAL_WORKSPACE_ID)
    emit('change', id, row?.name ?? null)
  } catch (error) { showAppError(errorMessage(error)) }
  finally { saving.value = false }
}
</script>

<template>
  <SelectPopup class="chat-workspace-picker" :options="options" :selected-label="name" :model-value="selectedOption?.value"
    :aria-label="`${t('projectWorkspaceUi.select')} · ${name}`" :disabled="disabled || saving" auto-flip
    @click="refresh" @update:model-value="select">
    <template #trigger="{ label }">
      <Icon :name="selectedIcon" size="sm" tone="inherit" />
      <span class="workspace-picker-label">{{ label }}</span>
    </template>
    <template #options="{ select: choose }">
      <template v-for="(option, index) in options" :key="option.value">
        <div v-if="index === 1" class="popup-menu-sep" role="separator"></div>
        <button type="button" class="popup-menu-item"
          :class="{ active: selectedOption?.value === option.value }"
          :disabled="loading || saving" @mousedown.stop.prevent @click="choose(option.value)">
          <Icon :name="option.icon" size="sm" tone="inherit" />
          {{ option.label }}
        </button>
      </template>
    </template>
  </SelectPopup>
</template>

<style scoped>
.chat-workspace-picker { flex: 0 1 auto; min-width: 0; }
.chat-workspace-picker :deep(.select-popup-trigger) { min-width: 0; max-width: 100%; height: 28px; padding: 0 7px; gap: 5px; justify-content: flex-start; font-size: inherit; color: var(--theme-content-tertiary); }
.chat-workspace-picker :deep(.select-popup-trigger:not(:hover, :focus-visible, .open)) { background: transparent; border-color: transparent; }
.workspace-picker-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
