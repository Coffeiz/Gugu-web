<template>
  <BaseModal
    :show="Boolean(active)"
    width="var(--confirm-dialog-width)"
    background="var(--confirm-dialog-bg)"
    @close="settle(false)"
  >
    <div v-if="active" class="confirm-dialog" :class="`is-${active.tone}`">
      <div class="confirm-dialog-head">
        <span class="confirm-dialog-icon" aria-hidden="true">
          <Icon :name="active.tone === 'danger' ? 'action.delete' : 'status.warning'" :size="18" />
        </span>
        <div class="confirm-dialog-copy">
          <h2>{{ active.title }}</h2>
          <p>{{ active.message }}</p>
        </div>
      </div>
      <div class="confirm-dialog-actions">
        <button type="button" class="confirm-dialog-cancel" @click="settle(false)">{{ active.cancelText }}</button>
        <button type="button" class="confirm-dialog-confirm" @click="settle(true)">{{ active.confirmText }}</button>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import BaseModal from './BaseModal.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

const { active, settle } = useConfirmDialog()
</script>

<style scoped>
.confirm-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--confirm-dialog-gap);
  padding: var(--confirm-dialog-padding);
  color: var(--confirm-dialog-fg);
}
.confirm-dialog-head { display: flex; gap: var(--confirm-dialog-gap); align-items: flex-start; }
.confirm-dialog-icon {
  width: var(--confirm-dialog-icon-size); height: var(--confirm-dialog-icon-size);
  display: grid; place-items: center; flex: 0 0 auto;
  border-radius: var(--radius-sm); color: var(--confirm-dialog-icon-fg);
  background: var(--confirm-dialog-icon-bg);
}
.confirm-dialog.is-danger .confirm-dialog-icon { color: var(--confirm-dialog-danger-icon-fg); background: var(--confirm-dialog-danger-icon-bg); }
.confirm-dialog-copy { min-width: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
.confirm-dialog-copy h2 { color: var(--confirm-dialog-title-fg); font: var(--font-weight-semibold) var(--font-size-md)/var(--line-height-ui) var(--font-sans); }
.confirm-dialog-copy p { color: var(--confirm-dialog-body-fg); font: var(--font-weight-regular) var(--font-size-sm)/var(--line-height-body) var(--font-sans); white-space: pre-line; }
.confirm-dialog-actions { display: flex; justify-content: flex-end; gap: var(--confirm-dialog-action-gap); }
.confirm-dialog-actions button { min-width: var(--confirm-dialog-button-min-width); height: var(--confirm-dialog-button-height); padding: 0 var(--space-md); border-radius: var(--radius-sm); font: var(--font-weight-medium) var(--font-size-sm) var(--font-sans); cursor: pointer; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.confirm-dialog-cancel { color: var(--confirm-dialog-cancel-fg); background: var(--confirm-dialog-cancel-bg); border: 1px solid var(--confirm-dialog-cancel-border); }
.confirm-dialog-cancel:hover { color: var(--confirm-dialog-cancel-fg-hover); background: var(--confirm-dialog-cancel-bg-hover); border-color: var(--confirm-dialog-cancel-border-hover); }
.confirm-dialog-confirm { color: var(--confirm-dialog-confirm-fg); background: var(--confirm-dialog-confirm-bg); border: 1px solid var(--confirm-dialog-confirm-border); }
.confirm-dialog-confirm:hover { background: var(--confirm-dialog-confirm-bg-hover); border-color: var(--confirm-dialog-confirm-border-hover); }
.confirm-dialog.is-danger .confirm-dialog-confirm { color: var(--confirm-dialog-danger-confirm-fg); background: var(--confirm-dialog-danger-confirm-bg); border-color: var(--confirm-dialog-danger-confirm-border); }
.confirm-dialog.is-danger .confirm-dialog-confirm:hover { background: var(--confirm-dialog-danger-confirm-bg-hover); border-color: var(--confirm-dialog-danger-confirm-border-hover); }
</style>
