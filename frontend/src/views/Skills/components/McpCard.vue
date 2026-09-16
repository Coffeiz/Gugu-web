<template>
  <article class="skill-card" :class="{ off: !props.server.enabled }">
    <div class="sc-top">
      <span class="sc-title-wrap">
        <span class="sc-state-dot" :class="`is-${statusState}`" aria-hidden="true"></span>
        <span class="sc-name" :title="props.server.name">{{ props.server.name }}</span>
      </span>
      <ToggleSwitch
        size="sm"
        :model-value="props.server.enabled"
        :disabled="props.busy"
        :aria-label="props.server.enabled ? t('skillsMcpUi.disabled') : t('skillsMcpUi.enabled')"
        @update:model-value="$emit('toggle', props.server)"
      />
    </div>
    <div class="sc-when">
      <span>{{ transportLabel }}</span>
      <span>{{ t('skillsMcpUi.toolCount', { count: props.server.loaded_tool_count ?? 0 }) }}</span>
      <span>{{ statusLabel }}</span>
    </div>
    <p class="sc-desc" :title="connectionTarget">{{ connectionTarget }}</p>
    <p v-if="props.server.has_credentials" class="sc-credential">{{ t('skillsMcpUi.credentialsConfigured') }}</p>
    <div class="sc-foot">
      <span class="sc-updated">{{ props.server.scope === 'user' ? t('skillsMcpUi.userScope') : props.server.scope }}</span>
      <span class="sc-acts">
        <button class="card-link-btn" :disabled="props.busy" @click="$emit('test', props.server)">{{ props.busy ? t('skillsMcpUi.testing') : t('skillsMcpUi.test') }}</button>
        <button class="card-link-btn" :disabled="props.busy" @click="$emit('reconnect', props.server)">{{ t('skillsMcpUi.reconnect') }}</button>
        <button class="card-link-btn" @click="$emit('edit', props.server)">{{ t('skillsMcpUi.edit') }}</button>
        <button class="card-link-btn danger" :disabled="props.busy" @click="$emit('remove', props.server)">{{ t('skillsMcpUi.delete') }}</button>
      </span>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import type { McpServerItem } from '@/services/api'

const props = defineProps<{ server: McpServerItem; busy?: boolean }>()
defineEmits<{
  (event: 'toggle' | 'test' | 'reconnect' | 'edit' | 'remove', server: McpServerItem): void
}>()

const { t } = useI18n()
const transportLabel = computed(() => props.server.transport === 'stdio' ? t('skillsMcpUi.stdioTransport') : t('skillsMcpUi.httpTransport'))
const statusState = computed(() => props.server.enabled ? (props.server.state || 'unloaded') : 'disabled')
const statusLabel = computed(() => props.server.enabled
  ? `${t('skillsMcpUi.enabled')} · ${t(`skillsMcpUi.state.${props.server.state || 'unloaded'}`)}`
  : t('skillsMcpUi.disabled'))
const connectionTarget = computed(() => props.server.transport === 'stdio' ? props.server.command : props.server.endpoint)
</script>

<style scoped>
.skill-card {
  position:relative; background:var(--surface-card); border:1px solid var(--border-strong);
  border-radius:var(--radius-md); box-shadow:var(--card-shadow); padding:13px 15px;
  display:flex; flex-direction:column; gap:7px; box-sizing:border-box; overflow:hidden;
  break-inside:avoid; transition:var(--card-motion), box-shadow var(--motion-hover-card) ease, opacity var(--hover-motion-control);
}
.skill-card::after { content:''; position:absolute; inset:0; border-radius:inherit; background:var(--card-hover-overlay); opacity:0; transition:var(--card-overlay-motion); pointer-events:none; }
.skill-card > * { position:relative; z-index:1; }.skill-card:hover { box-shadow:var(--card-shadow-hover); }.skill-card:hover::after { opacity:1; }.skill-card.off { opacity:.5; }
.sc-top { display:flex; align-items:center; gap:8px; min-width:0; }.sc-title-wrap { display:flex; align-items:center; gap:7px; min-width:0; flex:1; }
.sc-name { min-width:0; flex:1; font-size:13px; line-height:19px; font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sc-state-dot { width:7px; height:7px; border-radius:50%; background:var(--content-secondary); flex:0 0 auto; }.sc-state-dot.is-ok { background:var(--status-success); }.sc-state-dot.is-error, .sc-state-dot.is-backoff { background:var(--status-danger); }.sc-state-dot.is-disabled { background:var(--content-secondary); }
.sc-when { display:flex; gap:10px; min-width:0; font-size:12px; color:var(--text-secondary); }.sc-when span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.sc-desc { margin:0; padding:6px 9px; border-radius:8px; background:var(--surface-soft); font-size:12px; line-height:1.45; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.sc-credential { margin:0; color:var(--status-success); font-size:11px; }
.sc-foot { display:flex; align-items:flex-end; justify-content:space-between; gap:8px; margin-top:auto; }.sc-updated { min-width:0; font-size:11px; color:var(--text-secondary); opacity:.75; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.sc-acts { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
.sc-acts .card-link-btn:disabled { opacity:.5; cursor:default; }.sc-acts .card-link-btn:disabled:hover { background:transparent; color:var(--content-secondary); }
</style>
