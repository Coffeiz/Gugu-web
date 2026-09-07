<template>
  <BaseModal :show="props.show" width="460px" background="var(--panel-bg)" @close="emit('close')">
    <div class="filesystem-auth-dialog">
      <div class="dialog-heading">
        <div>
          <h2>{{ t('common.filesystemAuthTitle') }}</h2>
          <p v-if="props.subjectName">{{ props.subjectName }}</p>
        </div>
        <button type="button" class="close-button" :disabled="props.busy" @click="emit('close')">×</button>
      </div>
      <p class="dialog-message">{{ t(props.subjectType === 'session' ? 'common.filesystemAuthSessionMessage' : 'common.filesystemAuthMessage') }}</p>
      <div class="scope-box">
        <strong>{{ t('common.filesystemAuthScope') }}</strong>
        <span>/workspace · /personal · /project</span>
      </div>
      <div class="dialog-actions">
        <ActionButton variant="secondary" :disabled="props.busy" @click="emit('close')">
          {{ t('common.filesystemAuthCancel') }}
        </ActionButton>
        <ActionButton :disabled="props.busy" @click="emit('confirm')">
          {{ props.busy ? t('common.status.saving') : t('common.filesystemAuthConfirm') }}
        </ActionButton>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'

const props = defineProps<{
  show: boolean
  busy?: boolean
  subjectName?: string
  subjectType?: 'session' | 'scheduled_task'
}>()
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'confirm'): void
}>()
const { t } = useI18n()
</script>

<style scoped>
.filesystem-auth-dialog { padding: 20px; }
.dialog-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h2 { margin: 0; color: var(--content-primary); font: 700 18px/1.35 var(--font-sans); }
.dialog-heading p { margin: 5px 0 0; color: var(--content-secondary); font-size: 12px; }
.close-button { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; background: var(--option-bg); color: var(--content-secondary); font-size: 20px; line-height: 1; cursor: pointer; }
.close-button:hover:not(:disabled) { background: var(--option-bg-hover); color: var(--content-primary); }
.dialog-message { margin: 18px 0 12px; color: var(--content-primary); font-size: 13px; line-height: 1.6; }
.scope-box { display: flex; flex-direction: column; gap: 5px; padding: 12px; border: 1px solid var(--option-border); border-radius: var(--radius-sm); background: var(--option-bg); color: var(--content-secondary); font-size: 12px; }
.scope-box strong { color: var(--content-primary); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
</style>
