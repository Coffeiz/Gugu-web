<template>
  <div class="config-row config-row-switch">
    <div class="system-shell-copy">
      <span>{{ t('agent.systemShell') }}</span>
      <small>{{ t('agent.systemShellHint') }}</small>
      <small v-if="error" role="alert">{{ error }}</small>
    </div>
    <ToggleSwitch :model-value="config.cfg.agent.shell_system_enabled === true" :disabled="saving || config.loading"
      :aria-label="t('agent.systemShell')" @update:model-value="save" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { useConfigStore } from '@/stores/config'

const { t } = useI18n()
const config = useConfigStore()
const saving = ref(false)
const error = ref('')

async function save(enabled: boolean) {
  saving.value = true
  error.value = ''
  try {
    await config.saveConfig({ agent: { shell_system_enabled: enabled } })
    error.value = config.saveError
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.system-shell-copy { min-width: 0; }
.system-shell-copy > span { color: var(--content-tertiary); font-size: 12px; }
.system-shell-copy > small { display: block; margin-top: 4px; color: var(--content-tertiary); font-size: 11px; line-height: 1.4; }
</style>
