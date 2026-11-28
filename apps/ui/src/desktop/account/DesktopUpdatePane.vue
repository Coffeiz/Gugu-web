<template>
  <div v-if="status" class="pm-section">
    <h3 class="pm-section-label">{{ $t('pageUi.appUpdate') }}</h3>
    <div class="pm-field">
      <span class="pm-field-name">{{ $t('pageUi.currentVersion') }}</span>
      <div class="pm-static">{{ status.currentVersion }}</div>
    </div>
    <div v-if="status.version" class="pm-field">
      <span class="pm-field-name">{{ $t('pageUi.availableVersion') }}</span>
      <div class="pm-static">{{ status.version }}</div>
    </div>
    <p v-if="feedback || message" class="pm-field-hint" role="status">{{ feedback || (message ? $t(message) : '') }}</p>
    <progress v-if="status.state === 'downloading'" :value="status.progress" max="100" :aria-label="$t('pageUi.downloadProgress')" />
    <div v-if="action" class="update-actions">
      <ActionButton fit variant="secondary" type="button" :disabled="busy" @click="run(action.command)">
        {{ $t(action.label) }}
      </ActionButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DesktopUpdateBridge, DesktopUpdateCommand, DesktopUpdateStatus } from '@gugu/desktop-contracts'
import ActionButton from '@/components/common/controls/ActionButton.vue'

const { t } = useI18n()

const status = ref<DesktopUpdateStatus>()
const busy = ref(false)
const feedback = ref('')
const bridge = (window as Window & { guguDesktopUpdate?: DesktopUpdateBridge }).guguDesktopUpdate
let unsubscribe: (() => void) | undefined
const messages: Partial<Record<DesktopUpdateStatus['state'], string>> = {
  disabled: 'pageUi.updateDisabled',
  checking: 'pageUi.checkingUpdate',
  downloading: 'pageUi.downloadingUpdate',
  downloaded: 'pageUi.updateReady',
  installing: 'pageUi.closingWorkbench',
  failed: 'pageUi.updateFailed',
}
const message = computed(() => status.value && messages[status.value.state])
const actions: Partial<Record<DesktopUpdateStatus['state'], { label: string; command: DesktopUpdateCommand }>> = {
  idle: { label: 'pageUi.checkUpdate', command: 'check' },
  failed: { label: 'pageUi.recheckUpdate', command: 'check' },
  available: { label: 'pageUi.downloadUpdate', command: 'download' },
  downloaded: { label: 'pageUi.installRestart', command: 'install' },
}
const action = computed(() => status.value && actions[status.value.state])

async function run(command: DesktopUpdateCommand) {
  if (!bridge || busy.value) return
  busy.value = true
  feedback.value = ''
  try {
    const result = await bridge.command(command)
    if (result.ok === false) {
      feedback.value = result.error.message
      return
    }
    status.value = result.result
    if (command === 'check' && status.value.state === 'idle') feedback.value = t('pageUi.upToDate')
  } catch {
    feedback.value = t('pageUi.updateStatusFailed')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  unsubscribe = bridge?.onStatusChanged(next => { status.value = next })
  void run('status')
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<style scoped>
.update-actions { display: flex; justify-content: flex-end; }
progress { width: 100%; accent-color: var(--action-primary); }
</style>
