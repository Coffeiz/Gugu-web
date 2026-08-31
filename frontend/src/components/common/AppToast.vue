<template>
  <Teleport to="body">
    <Transition name="app-toast">
      <div
        v-if="currentToast"
        :key="currentToast.id"
        class="app-toast"
        :class="`app-toast--${currentToast.kind}`"
        :role="currentToast.kind === 'error' ? 'alert' : 'status'"
        :aria-live="currentToast.kind === 'error' ? 'assertive' : 'polite'"
      >
        <span class="app-toast__message">{{ currentToast.message }}</span>
      <button class="app-toast__close" type="button" :title="t('common.actions.close')" :aria-label="t('common.actions.close')" @click="dismissAppToast">
          <Icon name="action.close" :size="14" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import { useAppToast } from '@/composables/useAppToast'
import { useI18n } from 'vue-i18n'

const { currentToast, dismissAppToast } = useAppToast()
const { t } = useI18n()
</script>

<style scoped>
.app-toast {
  position: fixed;
  z-index: 100000;
  left: 50%;
  top: 64px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: max-content;
  max-width: min(440px, calc(100vw - 32px));
  padding: 9px 10px 9px 13px;
  border: 1px solid rgba(190, 95, 75, 0.3);
  border-radius: var(--radius-sm);
  background: rgba(255, 249, 247, 0.96);
  box-shadow: 0 8px 24px rgba(80, 50, 40, 0.14);
  color: #9a4739;
  font-size: 13px;
  line-height: 1.45;
  transform: translateX(-50%);
}

.app-toast__message { overflow-wrap: anywhere; white-space: pre-line; }
.app-toast__close {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: currentColor;
  cursor: pointer;
}
.app-toast__close:hover { background: rgba(154, 71, 57, 0.1); }

.app-toast--success {
  border-color: rgba(78, 137, 104, 0.3);
  background: rgba(247, 253, 248, 0.96);
  box-shadow: 0 8px 24px rgba(55, 96, 67, 0.14);
  color: #397151;
}
.app-toast--success .app-toast__close:hover { background: rgba(57, 113, 81, 0.1); }

.app-toast--info {
  border-color: rgba(104, 109, 153, 0.28);
  background: rgba(248, 249, 255, 0.96);
  box-shadow: 0 8px 24px rgba(63, 68, 105, 0.12);
  color: #5f6595;
}
.app-toast--info .app-toast__close:hover { background: rgba(95, 101, 149, 0.1); }

.app-toast-enter-active,
.app-toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.app-toast-enter-from,
.app-toast-leave-to { opacity: 0; transform: translate(-50%, -8px); }
</style>
