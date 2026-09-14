<template>
  <BaseModal :show="show" width="460px" background="var(--panel-bg)" @close="emit('close')">
    <form class="archive-dialog" @submit.prevent="submit">
      <header class="archive-dialog-header">
        <div class="archive-dialog-heading">
          <h2>{{ t(mode === 'compress' ? 'filesUi.archiveCompressTitle' : 'filesUi.archiveExtractTitle') }}</h2>
          <p>{{ t(mode === 'compress' ? 'filesUi.archiveCompressHint' : 'filesUi.archiveExtractHint') }}</p>
        </div>
        <button class="archive-close" type="button" :aria-label="t('common.actions.close')" @click="emit('close')">
          <Icon name="action.close" :size="14" />
        </button>
      </header>

      <div class="archive-dialog-body">
        <label class="archive-field">
          <span>{{ t(mode === 'compress' ? 'filesUi.archiveName' : 'filesUi.archiveFolderName') }}</span>
          <input v-model="name" :disabled="busy || Boolean(success)" :maxlength="mode === 'compress' ? 300 : 200" autocomplete="off" />
        </label>
        <p v-if="error" class="archive-message is-error" role="alert">{{ error }}</p>
        <p v-if="success" class="archive-message is-success" role="status">{{ success }}</p>
      </div>

      <footer class="archive-dialog-footer">
        <ActionButton variant="secondary" :disabled="busy" @click="emit('close')">
          {{ success ? t('common.actions.close') : t('common.actions.cancel') }}
        </ActionButton>
        <ActionButton v-if="!success" type="submit" :disabled="busy || !name.trim()">
          <span v-if="busy" class="archive-spinner" />
          {{ busy ? t('common.status.processing') : t(mode === 'compress' ? 'filesUi.compress' : 'filesUi.extract') }}
        </ActionButton>
      </footer>
    </form>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'

const props = defineProps<{
  show: boolean
  mode: 'compress' | 'extract'
  initialName: string
  busy: boolean
  error: string
  success: string
}>()
const emit = defineEmits<{
  close: []
  submit: [form: { name: string }]
}>()
const { t } = useI18n()
const name = ref(props.initialName)

watch(() => [props.show, props.initialName] as const, ([show]) => {
  if (!show) return
  name.value = props.initialName
})

function submit() {
  if (props.busy || props.success) return
  emit('submit', { name: name.value })
}
</script>

<style scoped>
.archive-dialog { display: flex; flex-direction: column; min-width: 0; }
.archive-dialog-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 20px 22px 16px; border-bottom: 1px solid var(--panel-divider);
}
.archive-dialog-heading { min-width: 0; }
.archive-dialog-heading h2 { margin: 0; color: var(--content-primary); font-size: 15px; font-weight: 700; }
.archive-dialog-heading p { margin: 6px 0 0; color: var(--content-secondary); font-size: 12px; line-height: 1.5; }
.archive-close {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 28px;
  width: 28px; height: 28px; border: 1px solid var(--control-border); border-radius: 8px;
  background: var(--control-bg); color: var(--content-secondary); cursor: pointer;
}
.archive-close:hover { background: var(--control-bg-hover); color: var(--content-primary); }
.archive-dialog-body { display: grid; gap: 16px; padding: 20px 22px; }
.archive-field { display: grid; gap: 7px; color: var(--content-secondary); font-size: 12px; }
.archive-field input {
  width: 100%; min-width: 0; box-sizing: border-box; height: 36px; padding: 0 11px;
  border: 1px solid var(--input-border); border-radius: var(--control-radius);
  background: var(--input-bg); color: var(--input-fg); font: 13px var(--font-sans);
}
.archive-field input:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.archive-message { margin: 0; padding: 9px 11px; border-radius: var(--radius-sm); font-size: 12px; line-height: 1.5; }
.archive-message.is-error { color: var(--danger-fg); background: var(--danger-bg); }
.archive-message.is-success { color: var(--status-success); background: var(--status-success-bg); }
.archive-dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px; padding: 14px 22px 18px;
  border-top: 1px solid var(--panel-divider);
}
.archive-spinner {
  width: 12px; height: 12px; border: 1.5px solid currentColor; border-right-color: transparent;
  border-radius: 50%; animation: archive-spin .7s linear infinite;
}
@keyframes archive-spin { to { transform: rotate(360deg); } }
</style>
