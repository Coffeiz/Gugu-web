<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'

defineProps({ canGoBack: Boolean, canGoForward: Boolean })
defineEmits<{ back: []; forward: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="breadcrumb-nav">
    <button type="button" class="nav-hist-btn" :disabled="!canGoBack" :title="t('files.back')" @click="$emit('back')">
      <Icon name="action.back" :size="14" />
    </button>
    <button type="button" class="nav-hist-btn" :disabled="!canGoForward" :title="t('files.forward')" @click="$emit('forward')">
      <Icon name="action.next" :size="14" />
    </button>
  </div>
</template>
