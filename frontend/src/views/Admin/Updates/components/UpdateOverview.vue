<template>
  <section class="update-card">
    <header class="card-head">
      <div class="card-icon"><Icon name="admin.stack" size="md" /></div>
      <div class="card-title-block">
        <h3>{{ t('adminUpdateUi.latestVersion') }}</h3>
        <p>{{ candidate?.published_at ? new Date(candidate.published_at).toLocaleString() : t('adminUpdateUi.notChecked') }}</p>
      </div>
      <a v-if="releaseNotesHref" class="release-link" :href="releaseNotesHref" target="_blank" rel="noopener noreferrer">
        {{ t('adminUpdateUi.releaseNotes') }}
      </a>
    </header>

    <div class="version-row">
      <div class="version-cell">
        <span>{{ t('adminUpdateUi.currentVersion') }}</span>
        <strong>{{ currentVersion || t('adminUpdateUi.currentUnknown') }}</strong>
      </div>
      <span class="version-arrow" aria-hidden="true">→</span>
      <div class="version-cell target-version">
        <span>{{ t('adminUpdateUi.latestVersion') }}</span>
        <strong>{{ candidate?.version || '—' }}</strong>
      </div>
      <div class="version-actions">
        <button class="btn-ghost" :disabled="checking || loading" @click="$emit('check')">
          {{ checking ? t('adminUpdateUi.checking') : t('adminUpdateUi.check') }}
        </button>
        <button v-if="hasUpdate" class="btn-primary" :disabled="preflighting || checking" @click="$emit('preflight')">
          {{ preflighting ? t('adminUpdateUi.preflighting') : t('adminUpdateUi.runPreflight') }}
        </button>
      </div>
    </div>

    <div v-if="checkResult" class="release-state" :class="hasUpdate ? 'is-update' : 'is-current'">
      {{ hasUpdate ? t('adminUpdateUi.available') : t('adminUpdateUi.noUpdate') }}
    </div>

    <div v-if="preflight" class="preflight-block">
      <h4>{{ t('adminUpdateUi.checks') }}</h4>
      <ul class="check-list">
        <li v-for="item in preflight.checks" :key="item.key" :class="item.ok ? 'passed' : 'failed'">
          <span class="check-mark" aria-hidden="true">{{ item.ok ? '✓' : '!' }}</span>
          <span>{{ checkLabel(item.key) }}</span>
          <span class="check-status">{{ item.ok ? t('adminUpdateUi.passed') : t('adminUpdateUi.failed') }}</span>
        </li>
      </ul>
      <p v-if="preflight.ready" class="migration-warning">{{ t('adminUpdateUi.migrationWarning') }}</p>
      <p v-else class="preflight-blocked">{{ t('adminUpdateUi.preflightFailed') }}</p>
      <button
        v-if="preflight.ready && preflight.challenge"
        class="btn-primary"
        :disabled="!!action"
        @click="$emit('start')"
      >{{ action ? t('adminUpdateUi.starting') : t('adminUpdateUi.beginUpdate') }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import type { UpdateCandidate, UpdatePreflight } from '@/services/adminUpdate'

const props = defineProps<{
  currentVersion: string
  candidate: UpdateCandidate | null
  hasUpdate: boolean
  checkResult: boolean | null
  preflight: UpdatePreflight | null
  checking: boolean
  loading: boolean
  preflighting: boolean
  action: string
}>()
defineEmits<{ check: []; preflight: []; start: [] }>()
const { t } = useI18n()
const releaseNotesHref = computed(() => {
  const value = props.candidate?.release_notes_url || ''
  return value.startsWith('https://github.com/Coffeiz/Gugu-web/releases/') ? value : ''
})

function checkLabel(key: string) {
  const translated = t(`adminUpdateUi.checkItems.${key}`)
  return translated === `adminUpdateUi.checkItems.${key}` ? key : translated
}
</script>

<style scoped>
.update-card { padding: 22px 24px; border: 1px solid var(--panel-glass-border); border-radius: var(--radius-lg); background: var(--panel-glass-bg); color: var(--content-primary); box-shadow: var(--elevation-card); }
.card-head { display: flex; align-items: center; gap: 13px; margin-bottom: 20px; }
.card-icon { display: grid; place-items: center; width: 38px; height: 38px; flex: 0 0 38px; border-radius: 11px; background: var(--selection-bg); color: var(--action-primary); }
.card-title-block { min-width: 0; flex: 1; }
.card-title-block h3 { margin: 0; font-size: 14px; font-weight: 700; }
.card-title-block p { margin: 4px 0 0; color: var(--content-tertiary); font-size: 12px; }
.release-link { color: var(--action-primary); font-size: 12px; text-decoration: none; }
.release-link:hover { text-decoration: underline; }
.version-row { display: flex; align-items: center; gap: 18px; padding: 16px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-glass); }
.version-cell { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 6px; }
.version-cell span { color: var(--content-tertiary); font-size: 12px; }
.version-cell strong { overflow: hidden; font-size: 17px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.target-version strong { color: var(--action-primary); }
.version-arrow { color: var(--content-tertiary); }
.version-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.btn-ghost, .btn-primary { min-height: 32px; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; }
.btn-ghost { border: 1px solid var(--border-subtle); background: var(--surface-glass); color: var(--content-secondary); }
.btn-primary { border: 0; background: var(--action-primary-bg); color: var(--content-on-accent); }
.btn-ghost:disabled, .btn-primary:disabled { cursor: default; opacity: .5; }
.release-state { margin-top: 14px; color: var(--content-tertiary); font-size: 12px; }
.release-state.is-update { color: var(--status-warning); }
.release-state.is-current { color: var(--status-success); }
.preflight-block { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--panel-divider); }
.preflight-block h4 { margin: 0 0 12px; font-size: 13px; }
.check-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.check-list li { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); font-size: 12px; }
.check-list li.passed .check-mark { color: var(--status-success); }
.check-list li.failed .check-mark { color: var(--status-danger); }
.check-mark { display: grid; width: 17px; height: 17px; place-items: center; border-radius: 50%; background: var(--selection-bg); font-weight: 700; }
.check-status { margin-left: auto; color: var(--content-tertiary); }
.migration-warning, .preflight-blocked { margin: 14px 0; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--status-warning) 35%, transparent); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--status-warning) 9%, transparent); color: var(--content-secondary); font-size: 12px; line-height: 1.6; }
.preflight-blocked { border-color: color-mix(in srgb, var(--status-danger) 35%, transparent); background: color-mix(in srgb, var(--status-danger) 9%, transparent); }
@media (max-width: 760px) { .version-row { align-items: stretch; flex-wrap: wrap; } .version-actions { width: 100%; justify-content: flex-start; } }
</style>
