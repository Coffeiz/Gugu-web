<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'

const props = defineProps({ show: Boolean, busy: Boolean, local: Boolean, error: String })
const emit = defineEmits<{ close: []; submit: [] }>()
const name = defineModel('name', { default: '' })
const { t } = useI18n()
const createInput = ref<HTMLInputElement | null>(null)
watch(() => props.show, async show => {
  if (show) {
    await nextTick()
    createInput.value?.focus()
  }
})
function submit() {
  if (!props.busy && (props.local || name.value.trim())) emit('submit')
}
</script>

<template>
  <BaseModal
    :show="show"
    width="var(--confirm-dialog-width)"
    background="var(--modal-card-bg)"
    teleport-to="body"
    @close="$emit('close')"
  >
    <form class="workspace-modal" @submit.prevent="submit">
      <div class="workspace-modal-heading">
        <h2>{{ t(local ? 'filesUi.addDesktopWorkspace' : 'workspaceUi.createWorkspace') }}</h2>
        <p>{{ t(local ? 'filesUi.localWorkspaceHint' : 'workspaceUi.createWorkspaceHint') }}</p>
      </div>
      <input v-if="!local" ref="createInput" v-model="name" class="workspace-input" :placeholder="t('workspaceUi.workspaceNamePlaceholder')" maxlength="200" autofocus />
      <p v-if="error" class="workspace-form-error">{{ error }}</p>
      <div class="workspace-modal-actions">
        <ActionButton variant="secondary" fit type="button" @click="$emit('close')">{{ t('common.actions.cancel') }}</ActionButton>
        <ActionButton fit type="submit" :disabled="busy || (!local && !name.trim())">{{ busy ? t('common.status.saving') : t(local ? 'filesUi.chooseWorkspaceFolder' : 'common.actions.confirm') }}</ActionButton>
      </div>
    </form>
  </BaseModal>
</template>

<style scoped>
.workspace-modal {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--confirm-dialog-padding);
  color: var(--text-primary);
}
.workspace-modal-heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.workspace-modal h2 {
  margin: 0;
  font: var(--font-weight-semibold) var(--font-size-lg)/var(--line-height-ui) var(--font-sans);
}
.workspace-modal-heading p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
/* 输入框交互口径对齐 .pm-workspace-input（ProfileWorkspacesPane）：基态声明透明
   聚焦时沿用共享输入框的高亮描边。 */
.workspace-input { box-sizing:border-box; width:100%; height:38px; padding:0 12px; color:var(--text-primary); background:var(--input-bg); border:1px solid var(--input-border); border-radius:var(--radius-xs); font:var(--font-weight-regular) var(--font-size-sm) var(--font-sans); outline:none; box-shadow:var(--input-hover-shadow), 0 0 0 0 transparent; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.workspace-input:hover { border-color:var(--input-border-hover); background:var(--input-bg-hover); }
.workspace-input:focus { border-color:var(--input-border-focus); background:var(--input-bg-focus); box-shadow:var(--input-hover-shadow); }
.workspace-form-error {
  margin: 0;
  color: var(--danger-button-fg);
}
.workspace-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}
</style>
