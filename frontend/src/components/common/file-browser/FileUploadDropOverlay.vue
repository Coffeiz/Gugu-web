<template>
  <Transition name="drop-fade">
    <div v-if="visible" class="drop-overlay" @dragover.prevent @drop.prevent="$emit('drop', $event)" @dragleave.stop>
      <div class="drop-zone-hint">
        <svg width="36" height="36" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 30V16M15 22l7-7 7 7"/><path d="M8 36h28"/>
        </svg>
  <span class="drop-hint">{{ t('chat.dropAttachment') }}</span>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
defineProps({ visible: Boolean })
defineEmits<{ drop: [event: DragEvent] }>()
</script>
