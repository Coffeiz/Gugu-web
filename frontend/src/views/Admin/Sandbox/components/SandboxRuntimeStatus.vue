<template>
  <section class="section-wrap">
    <div class="section-head">
      <span class="section-label">{{ t('adminSandbox.runtime') }}</span>
      <span class="section-desc">{{ t('adminSandbox.runtimeHint') }}</span>
    </div>
    <div class="panel-card">
      <div class="status-head">
        <h3>{{ status.message || t('adminSandbox.readingDocker') }}</h3>
        <span class="status-pill" :class="`status-${status.state}`">{{ stateLabel }}</span>
      </div>
      <div class="status-grid">
        <div><span>{{ t('adminSandbox.managerMode') }}</span><strong>{{ managerModeLabel }}</strong></div>
        <div><span>{{ t('adminSandbox.manager') }}</span><strong>{{ managerStatusLabel }}</strong></div>
        <div><span>Docker CLI</span><strong>{{ status.docker_installed ? t('adminSandbox.installed') : t('adminSandbox.dockerMissing') }}</strong></div>
        <div><span>Docker daemon</span><strong>{{ status.docker_daemon_ready ? t('adminSandbox.ready') : t('adminSandbox.unavailable') }}</strong></div>
        <div><span>{{ t('adminSandbox.runtimeImage') }}</span><strong>{{ status.image_ready ? t('adminSandbox.ready') : t('adminSandbox.unavailable') }}</strong></div>
        <div><span>Rootless</span><strong>{{ status.rootless === true ? t('adminSandbox.enabled') : status.rootless === false ? t('adminSandbox.notEnabled') : t('adminSandbox.unknown') }}</strong></div>
        <div><span>{{ t('adminSandbox.executor') }}</span><strong>{{ status.executor_ready ? t('adminSandbox.canUse') : t('adminSandbox.cannotUse') }}</strong></div>
      </div>
      <p v-if="!canEnable && !status.enabled" class="status-note">{{ t('adminSandbox.cannotEnable') }}</p>
      <p v-if="status.manager_mode !== 'disabled' && !status.manager_ready && status.manager_message" class="status-note">{{ status.manager_message }}</p>
      <p v-if="status.rootless === false && !status.rootless_required" class="status-note">{{ t('adminSandbox.configHint') }}</p>
      <p v-if="status.enabled" class="status-note">{{ t('adminSandbox.stoppedNotice') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  canEnable: boolean
  status: {
    manager_mode: string
    manager_ready: boolean
    manager_message: string
    enabled: boolean
    docker_installed: boolean
    docker_daemon_ready: boolean
    rootless: boolean | null
    rootless_required: boolean
    image_ready: boolean
    executor_ready: boolean
    state: string
    message: string
  }
}>()

const { t } = useI18n()
const managerStatusLabel = computed(() => props.status.manager_mode === 'disabled'
  ? t('adminSandbox.modeDisabled')
  : props.status.manager_ready ? t('adminSandbox.ready') : t('adminSandbox.unavailable'))
const managerModeLabel = computed(() => ({
  embedded: t('adminSandbox.modeEmbedded'),
  external: t('adminSandbox.modeExternal'),
  disabled: t('adminSandbox.modeDisabled'),
} as Record<string, string>)[props.status.manager_mode] || t('adminSandbox.modeInvalid'))
const stateLabel = computed(() => ({
  ready: t('adminSandbox.ready'),
  disabled: t('adminSandbox.disabled'),
  docker_missing: t('adminSandbox.dockerMissing'),
  docker_unavailable: t('adminSandbox.dockerUnavailable'),
  rootless_required: t('adminSandbox.rootlessRequired'),
  image_unavailable: t('adminSandbox.imageUnavailable'),
  manager_unavailable: t('adminSandbox.managerUnavailable'),
} as Record<string, string>)[props.status.state] || t('adminSandbox.unknown'))
</script>

<style scoped>
.section-wrap { padding: 20px 36px 0; }
.section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.section-label { color: var(--content-primary); font-size: 13px; font-weight: 600; }
.section-desc { color: var(--content-tertiary); font-size: 12px; }
.panel-card { padding: 22px 24px; border: 1px solid var(--panel-glass-border); border-radius: var(--radius-lg); background: var(--panel-glass-bg); box-shadow: var(--elevation-card); color: var(--content-primary); backdrop-filter: var(--panel-glass-blur); -webkit-backdrop-filter: var(--panel-glass-blur); }
.status-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h3 { min-width: 0; margin: 0; color: var(--content-primary); font-size: 14px; font-weight: 700; }
.status-pill { flex-shrink: 0; padding: 5px 10px; border-radius: var(--radius-pill); background: var(--surface-muted); color: var(--content-secondary); font-size: 12px; }
.status-ready { background: color-mix(in srgb, var(--status-success) 12%, transparent); color: var(--status-success); }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 20px; }
.status-grid div { min-width: 0; padding: 12px; border: 1px solid var(--panel-divider); border-radius: var(--radius-sm); background: var(--surface-glass); }
.status-grid span { display: block; color: var(--content-tertiary); font-size: 12px; }
.status-grid strong { display: block; margin-top: 6px; color: var(--content-primary); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.status-note { margin: 10px 0 0; color: var(--content-tertiary); font-size: 12px; line-height: 1.6; }
@media (max-width: 760px) { .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .section-wrap { padding-left: 20px; padding-right: 20px; } }
</style>
