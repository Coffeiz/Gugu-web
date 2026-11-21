<template>
  <section class="section-wrap">
    <div class="section-head">
      <span class="section-label">{{ t('adminSandbox.runtime') }}</span>
      <span class="section-desc">{{ t('adminSandbox.runtimeHint') }}</span>
    </div>
    <div class="panel-card">
      <div class="status-head">
        <h3>{{ headline }}</h3>
        <span class="status-pill" :class="`status-${status.state}`">{{ stateLabel }}</span>
      </div>
      <div class="status-grid">
        <div><span>{{ t('adminSandbox.isolationRuntime') }}</span><strong>{{ status.runtime_supported ? t('adminSandbox.ready') : t('adminSandbox.unavailable') }}</strong></div>
        <div><span>{{ t('adminSandbox.executionBackend') }}</span><strong>{{ offlineOnly ? 'Bubblewrap' : status.runtime_methods.join(', ') || t('adminSandbox.unknown') }}</strong></div>
        <div><span>{{ t('adminSandbox.shellExecution') }}</span><strong>{{ status.shell_enabled ? t('adminSandbox.enabled') : t('adminSandbox.disabled') }}</strong></div>
        <div><span>{{ t('adminSandbox.sandboxEnabled') }}</span><strong>{{ status.enabled ? t('adminSandbox.enabled') : t('adminSandbox.disabled') }}</strong></div>
        <div><span>{{ t('adminSandbox.dangerousShell') }}</span><strong>{{ status.shell_dangerous_enabled ? t('adminSandbox.enabled') : t('adminSandbox.disabled') }}</strong></div>
        <div v-if="!offlineOnly"><span>{{ t('adminSandbox.proxyOnlyEgress') }}</span><strong>{{ status.egress_network_ready ? t('adminSandbox.ready') : t('adminSandbox.unavailable') }}</strong></div>
      </div>
      <p v-if="!status.readiness_checked" class="status-note">{{ t('adminSandbox.readinessUnavailable') }}</p>
      <p v-if="status.state === 'egress_unready'" class="status-note">{{ status.egress_config_error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  offlineOnly: boolean
  status: {
    enabled: boolean
    sandbox_ready: boolean
    shell_enabled: boolean
    shell_dangerous_enabled: boolean
    runtime_supported: boolean
    runtime_methods: string[]
    readiness_checked: boolean
    egress_network_ready: boolean
    egress_config_error: string | null
    state: string
    message: string
  }
}>()

const { t } = useI18n()
const headline = computed(() => props.offlineOnly && props.status.state === 'ready'
  ? t('adminSandbox.bubblewrapReady')
  : props.status.message || t('adminSandbox.readingRuntime'))
const stateLabel = computed(() => props.status.state === 'ready' ? t('adminSandbox.ready')
  : props.status.state === 'disabled' ? t('adminSandbox.disabled') : t('adminSandbox.unavailable'))
</script>

<style scoped>
.section-wrap { padding: 20px 36px 0; }
.section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.section-label { color: var(--content-primary); font-size: 13px; font-weight: 600; }
.section-desc { color: var(--content-tertiary); font-size: 12px; }
.panel-card { padding: 22px 24px; border: 1px solid var(--panel-glass-border); border-radius: var(--card-radius); background: var(--panel-glass-bg); box-shadow: var(--elevation-card); color: var(--content-primary); backdrop-filter: var(--panel-glass-blur); -webkit-backdrop-filter: var(--panel-glass-blur); }
.status-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h3 { min-width: 0; margin: 0; color: var(--content-primary); font-size: 14px; font-weight: 700; }
.status-pill { flex-shrink: 0; padding: 5px 10px; border-radius: var(--radius-pill); background: var(--surface-muted); color: var(--content-secondary); font-size: 12px; }
.status-ready { background: color-mix(in srgb, var(--status-success) 12%, transparent); color: var(--status-success); }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 20px; }
.status-grid div { min-width: 0; padding: 12px; border: 1px solid var(--panel-divider); border-radius: var(--radius-xs); background: var(--surface-glass); }
.status-grid span { display: block; color: var(--content-tertiary); font-size: 12px; }
.status-grid strong { display: block; margin-top: 6px; color: var(--content-primary); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.status-note { margin: 10px 0 0; color: var(--content-tertiary); font-size: 12px; line-height: 1.6; }
@media (max-width: 760px) { .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .section-wrap { padding-left: 20px; padding-right: 20px; } }
</style>
