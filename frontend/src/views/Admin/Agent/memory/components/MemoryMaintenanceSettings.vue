<template>
  <section class="config-card">
    <div class="card-head"><div class="card-icon"><Icon name="admin.time" size="sm" /></div><div class="card-title-block"><h3>{{ t('memorySettingsUi.title') }}</h3><p>{{ t('memorySettingsUi.description') }}</p></div></div>
    <div class="behavior-grid">
      <div class="behavior-item"><div class="behavior-label"><span>{{ t('memorySettingsUi.system') }}</span><span class="behavior-desc">{{ t('memorySettingsUi.systemHint') }}</span></div><ToggleSwitch v-model="agentDraft.memory_enabled" :aria-label="t('memorySettingsUi.toggleSystem')" /></div>
      <div class="behavior-item"><div class="behavior-label"><span>{{ t('memorySettingsUi.reflectionThreshold') }}</span><span class="behavior-desc">{{ t('memorySettingsUi.reflectionHint') }}</span></div><input v-model.number="agentDraft.reflection_threshold" type="number" min="1" max="100" class="behavior-input" /></div>
      <div class="behavior-item"><div class="behavior-label"><span>{{ t('memorySettingsUi.dailyRetention') }}</span><span class="behavior-desc">{{ t('memorySettingsUi.dailyHint') }}</span></div><input v-model.number="agentDraft.daily_retention_days" type="number" min="1" max="90" class="behavior-input" /></div>
    </div>
    <div class="card-actions"><span class="save-hint" :class="{ error: !!behaviorError }">{{ behaviorSaved ? t('adminAgentMemory.saved') : behaviorError }}</span><button class="btn-ghost" @click="resetBehavior">{{ t('adminAgentMemory.undo') }}</button><button class="btn-primary" :disabled="behaviorSaving" @click="saveBehavior">{{ behaviorSaving ? t('adminAgentMemory.saving') : t('adminAgentMemory.save') }}</button></div>
  </section>
</template>
<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { useAgentRuntimeConfig } from '../../runtime-config/useAgentRuntimeConfig'
const { configStore, agentDraft, behaviorSaving, behaviorSaved, behaviorError, resetBehavior, saveBehavior } = useAgentRuntimeConfig()
const { t } = useI18n()
onMounted(async () => { await configStore.fetchConfig(); Object.assign(agentDraft, configStore.cfg.agent) })
</script>
<style scoped>
.config-card{background:var(--panel-glass-bg);border:1px solid var(--panel-glass-border);border-radius:var(--radius-lg);padding:22px 24px;color:var(--content-primary);box-shadow:var(--elevation-card);backdrop-filter:var(--panel-glass-blur);-webkit-backdrop-filter:var(--panel-glass-blur)}.card-head{display:flex;align-items:center;gap:13px;margin-bottom:20px}.card-icon{width:38px;height:38px;border-radius:11px;background:var(--selection-bg);color:var(--action-primary);display:flex;align-items:center;justify-content:center}.card-title-block{flex:1}.card-title-block h3{font-size:14px;font-weight:700}.card-title-block p{margin-top:3px;color:var(--content-tertiary);font-size:12px;line-height:1.5}.behavior-grid{display:flex;flex-direction:column;gap:2px}.behavior-item{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--panel-divider)}.behavior-item:last-child{border-bottom:0}.behavior-label{display:flex;flex-direction:column;gap:3px}.behavior-label>span:first-child{font-size:13px;font-weight:500}.behavior-desc{color:var(--content-tertiary);font-size:12px;line-height:1.5}.behavior-input{width:96px;flex:0 0 96px;box-sizing:border-box;padding:7px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:var(--surface-glass);color:var(--content-primary);text-align:center}.card-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--panel-divider)}.save-hint{flex:1;color:var(--status-success);font-size:12px}.save-hint.error{color:var(--status-danger)}.btn-ghost,.btn-primary{min-height:30px;padding:6px 14px;border-radius:var(--radius-sm);font-size:13px;cursor:pointer}.btn-ghost{border:1px solid var(--border-subtle);background:var(--surface-glass);color:var(--content-secondary)}.btn-primary{border:0;background:var(--action-primary-bg);color:var(--content-on-accent)}.btn-primary:disabled{opacity:.5}
@media(max-width:720px){.behavior-item{align-items:flex-start;flex-direction:column}.behavior-input{width:100%;flex-basis:auto}}
</style>
