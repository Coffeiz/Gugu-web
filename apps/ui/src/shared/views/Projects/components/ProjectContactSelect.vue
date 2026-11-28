<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import { useProjectAccess } from '@/api/projects'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
const props = defineProps({ modelValue: { type: String, default: '' } })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const { t } = useI18n()
const access = useProjectAccess()
const names = ref<string[]>([])
const loading = ref(true)
let active = true
onScopeDispose(() => { active = false })
const options = computed(() => [{ value: '', label: t('projectContactUi.none') }, ...names.value.map(name => ({ value: name, label: name }))])
onMounted(async () => {
  try {
    const contacts = await access.listContacts?.() ?? []
    if (active) names.value = [...new Set(contacts.map(contact => contact.name).filter(Boolean))]
  } catch (error) { if (active) showAppError(errorMessage(error)) }
  finally { if (active) loading.value = false }
})
</script>

<template>
  <SelectPopup class="project-contact-select" :model-value="modelValue" :selected-label="modelValue || t('projectContactUi.none')"
    :options="options" :disabled="loading" :aria-label="t('projects.client')"
    @update:model-value="emit('update:modelValue', $event)">
    <template #trigger="{ label, open }">
      <span class="project-contact-trigger-content">{{ label }}</span>
      <FlipChevron :open="open" :size="11" class="project-contact-chevron" />
    </template>
    <template #options="{ select }">
      <button v-for="option in options" :key="option.value" type="button" class="popup-menu-item project-contact-option"
        :class="{ active: modelValue === option.value }" @mousedown.prevent="select(option.value)">
        <span>{{ option.label }}</span>
      </button>
    </template>
  </SelectPopup>
</template>

<style scoped>
.project-contact-select { width: 100%; min-width: 0; }
.project-contact-select :deep(.select-popup-trigger) { position: relative; width: 100%; min-width: 0; min-height: var(--control-sm); justify-content: center; }
.project-contact-trigger-content { display: inline-block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.5; }
.project-contact-select :deep(.select-popup-trigger > .project-contact-chevron) { position: absolute; right: 12px; color: var(--popup-item-fg-muted); }
.project-contact-option { display: flex; align-items: center; justify-content: center; gap: var(--space-xs); text-align: center; }
.project-contact-option > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
