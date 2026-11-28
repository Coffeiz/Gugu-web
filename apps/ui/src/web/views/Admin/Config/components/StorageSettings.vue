<template>
  <section id="sec-storage" class="config-card">
    <div class="card-head">
      <div class="card-icon" style="--ic:rgba(176,120,88,0.12);--stroke:#b07858">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6C3 4.9 3.9 4 5 4h4l2 2h6c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V6z"/>
        </svg>
      </div>
      <div class="card-title-block">
        <h3>{{ t('configUi.fileStorage') }}</h3>
        <p>{{ t('configUi.fileStorageHint') }}</p>
      </div>
    </div>

    <p v-if="modelValue.backend !== 'local'" class="config-card-note" role="status">
      {{ t('configUi.storageUnsupported') }}
    </p>
    <div v-else class="field-grid">
      <ConfigField
        :label="t('configUi.storagePath')"
        :model-value="localPath"
        placeholder="../Gugu-data/users"
        class="span2"
        @update:model-value="updateLocalPath"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfigField from './ConfigField.vue'

const props = defineProps<{ modelValue: Record<string, unknown> }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()
const { t } = useI18n()

const localPath = computed(() => typeof props.modelValue.local_path === 'string' ? props.modelValue.local_path : '')

function updateLocalPath(value: string) {
  emit('update:modelValue', { ...props.modelValue, local_path: value })
}
</script>
