<template>
  <section class="config-card">
    <div class="card-head">
      <div class="card-icon" style="--ic:var(--selection-bg);--stroke:var(--action-primary)">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a6 6 0 1 1 2 4.5M4 10V6M4 10H8"/></svg>
      </div>
      <div class="card-title-block">
        <h3>{{ t('memoryMaintenanceUi.title') }}</h3>
        <p>{{ t('memoryMaintenanceUi.description') }}</p>
      </div>
    </div>
    <div class="behavior-grid">
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>{{ t('memoryMaintenanceUi.preview') }}</span><span class="behavior-desc">{{ t('memoryMaintenanceUi.previewHint') }}</span></div>
        <div class="action-row">
          <span v-if="mem.msg" class="action-message" :class="{ error: mem.error }" :title="mem.msg">{{ mem.msg }}</span>
          <button type="button" class="btn-ghost" :disabled="mem.running" @click="startPreview">{{ mem.running ? `${t('memoryMaintenanceUi.previewing')} ${mem.done}/${mem.total}` : t('memoryMaintenanceUi.preview') }}</button>
        </div>
      </div>
      <div v-if="mem.status === 'done'" class="behavior-item full-row result-block memory-subpanel">
        <div class="result-head">
          <span class="behavior-desc">{{ userCount === 0 ? t('memoryMaintenanceUi.completedEmpty') : t('memoryMaintenanceUi.completed', { users: userCount, removed: totalRemoved, moved: totalMoved, events: totalProfileEvents, daily: totalDaily, legacy: totalLegacy }) }}</span>
          <button v-if="userCount > 0" type="button" class="btn-ghost detail-btn" @click="mem.expanded = !mem.expanded">{{ mem.expanded ? t('memoryMaintenanceUi.collapseDetails') : t('memoryMaintenanceUi.details') }}</button>
        </div>
        <div v-if="mem.expanded && userCount > 0" class="mem-cleanup-detail">
          <div v-for="(item, uid) in mem.plan" :key="uid">
            <template v-if="item.removed_texts?.length || item.moved_texts?.length || item.profile_event_texts?.length || item.daily_texts?.length || item.legacy_files?.length">
              <div class="mem-cleanup-uid">{{ uid }}（{{ t('memoryMaintenanceUi.itemCount', { count: item.total }) }}）</div>
              <div v-for="(text, i) in item.removed_texts" :key="`r${i}`" class="mem-cleanup-text">· [{{ t('memoryMaintenanceUi.removedTag') }}] {{ text }}</div>
              <div v-for="(text, i) in item.moved_texts" :key="`m${i}`" class="mem-cleanup-text moved">· [{{ t('memoryMaintenanceUi.movedTag') }}] {{ text }}</div>
              <div v-for="(text, i) in item.profile_event_texts" :key="`pe${i}`" class="mem-cleanup-text profile-event">· [{{ t('memoryMaintenanceUi.profileEventTag') }}] {{ text }}</div>
              <div v-for="(text, i) in item.daily_texts" :key="`d${i}`" class="mem-cleanup-text daily">· [{{ t('memoryMaintenanceUi.dailyTag') }}] {{ text }}</div>
              <div v-for="(file, i) in item.legacy_files" :key="`l${i}`" class="mem-cleanup-text legacy">· [{{ t('memoryMaintenanceUi.legacyTag') }}] {{ file }}</div>
            </template>
            <div v-else-if="item.error" class="mem-cleanup-uid error">{{ uid }}：{{ item.error }}</div>
          </div>
        </div>
        <div class="result-actions">
          <span v-if="applyMsg" class="action-message" :class="{ error: mem.applyError }">{{ applyMsg }}</span>
          <button v-if="userCount > 0" type="button" class="btn-primary" :disabled="mem.applying" @click="apply">{{ mem.applying ? t('memoryMaintenanceUi.executing') : t('memoryMaintenanceUi.confirmExecute') }}</button>
        </div>
      </div>
    </div>
  </section>

  <section class="config-card">
    <div class="card-head">
      <div class="card-icon" style="--ic:var(--selection-bg);--stroke:var(--action-primary)"><Icon name="communication.team" size="sm" /></div>
      <div class="card-title-block"><h3>{{ t('memoryMaintenanceUi.imTitle') }}</h3><p>{{ t('memoryMaintenanceUi.imDescription') }}</p></div>
    </div>
    <div v-if="imScopes.error" class="save-hint error">{{ imScopes.error }}</div>
    <div v-if="imScopes.message" class="save-hint">{{ imScopes.message }}</div>
    <div class="behavior-grid">
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>{{ t('memoryMaintenanceUi.preview') }}</span><span class="behavior-desc">{{ t('memoryMaintenanceUi.readOnly') }}</span></div>
        <div class="action-row"><span v-if="imPreview.message" class="behavior-desc">{{ imPreview.message }}</span><button type="button" class="btn-ghost" :disabled="imPreview.running" @click="startImPreview">{{ imPreview.running ? `${t('memoryMaintenanceUi.previewing')} ${imPreview.done}/${imPreview.total}` : t('memoryMaintenanceUi.preview') }}</button></div>
      </div>
    </div>
    <div v-if="imPreview.hasRun && !imPreview.running">
      <div class="memory-subpanel im-memory-result">
      <div class="im-memory-summary-grid">
        <div><strong>{{ imScopes.summary.total_scopes }}</strong><span>{{ t('memoryMaintenanceUi.scopes') }}</span></div><div><strong>{{ imScopes.summary.groups }}</strong><span>{{ t('memoryMaintenanceUi.groups') }}</span></div><div><strong>{{ imScopes.summary.members }}</strong><span>{{ t('memoryMaintenanceUi.members') }}</span></div><div><strong>{{ imScopes.summary.total_entries }}</strong><span>{{ t('memoryMaintenanceUi.entries') }}</span></div><div><strong>{{ imPreview.needsReview }}</strong><span>{{ t('memoryMaintenanceUi.suggested') }}</span></div><div><strong>{{ imScopes.summary.needs_maintenance }}</strong><span>{{ t('memoryMaintenanceUi.needsMaintenance') }}</span></div><div><strong>{{ imScopes.summary.failed_jobs }}</strong><span>{{ t('memoryMaintenanceUi.failedJobs') }}</span></div>
      </div>
      <div v-if="imScopes.summary.platforms.length" class="im-memory-platforms"><span v-for="platform in imScopes.summary.platforms" :key="platform.platform" class="im-memory-platform">{{ t('memoryMaintenanceUi.platformSummary', { platform: platform.platform, scopes: platform.scopes, entries: platform.entries }) }}</span></div>
      <div class="im-memory-maintenance-actions"><span class="behavior-desc">{{ t('memoryMaintenanceUi.maintenanceHint') }}</span><button type="button" class="btn-primary memory-action-button" :disabled="imScopes.applying || !imPreview.planReady" @click="applyIm">{{ imScopes.applying ? t('memoryMaintenanceUi.executing') : t('memoryMaintenanceUi.confirmAll') }}</button></div>
      <div v-if="imPreview.message" class="im-memory-progress">{{ imPreview.message }}</div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import Icon from '@/components/common/Icon.vue'
import { useMemoryMaintenance } from '../useMemoryMaintenance'
import { useImMemoryMaintenance } from '../useImMemoryMaintenance'

const adminStore = useAdminStore()
const { t } = useI18n()
const memory = useMemoryMaintenance(adminStore)
const { state: mem, userCount, totalRemoved, totalMoved, totalProfileEvents, totalDaily, totalLegacy, applyMsg, startPreview, apply } = memory
const imMemory = useImMemoryMaintenance(adminStore)
const { state: imScopes, preview: imPreview, startPreview: startImPreview, apply: applyIm } = imMemory
</script>

<style scoped>
.config-card { background: var(--panel-glass-bg); border: 1px solid var(--panel-glass-border); border-radius: var(--radius-lg); padding: 22px 24px; color: var(--content-primary); box-shadow: var(--elevation-card); backdrop-filter: var(--panel-glass-blur); -webkit-backdrop-filter: var(--panel-glass-blur); }
.card-head { display:flex; align-items:center; gap:13px; margin-bottom:20px; }
.card-icon { width:38px; height:38px; border-radius:11px; background:var(--ic); display:flex; align-items:center; justify-content:center; flex:0 0 38px; }
.card-icon svg { width:18px; height:18px; color:var(--stroke); }
.card-title-block { flex:1; min-width:0; }
.card-title-block h3 { color:var(--content-primary); font-size:var(--font-size-md,14px); font-weight:var(--font-weight-bold,700); line-height:var(--line-height-ui,1.4); }
.card-title-block p { margin-top:3px; color:var(--content-tertiary); font-size:var(--font-size-sm,12px); line-height:var(--line-height-body,1.5); }
.behavior-grid { display:flex; flex-direction:column; gap:2px; }
.behavior-item { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 0; border-bottom:1px solid var(--panel-divider); }
.behavior-item:last-child { border-bottom:0; }
.behavior-label { display:flex; flex-direction:column; gap:3px; min-width:0; }
.behavior-label > span:first-child { color:var(--content-primary); font-size:var(--font-size-sm,13px); font-weight:var(--font-weight-medium,500); line-height:var(--line-height-ui,1.4); }
.full-row { grid-column: 1 / -1; }
.memory-action-button { flex: 0 0 auto; width: fit-content; min-width: 0; white-space: nowrap; }
.memory-subpanel { padding: 2px 12px; background: var(--panel-glass-bg); border: 1px solid var(--panel-glass-border); border-radius: var(--radius-md); box-shadow: var(--panel-glass-shadow); backdrop-filter: var(--panel-glass-blur); -webkit-backdrop-filter: var(--panel-glass-blur); }
.action-row,.result-head,.result-actions { display:flex; align-items:center; justify-content:flex-end; gap:10px; min-width:0; }
.action-message { min-width:0; overflow:hidden; color:var(--status-success); font-size:var(--font-size-sm,12px); line-height:var(--line-height-ui,1.4); text-overflow:ellipsis; white-space:nowrap; }
.action-message.error,.mem-cleanup-uid.error { color:var(--status-danger); }
.result-block { flex-direction:column; align-items:stretch; gap:10px; }
.result-head { justify-content:space-between; }
.detail-btn { font-size:12px; padding:4px 10px; }
.mem-cleanup-detail { max-height:300px; overflow:auto; padding:10px; border:1px solid var(--panel-divider); border-radius:var(--radius-sm); background:var(--surface-soft); }
.mem-cleanup-uid { margin-top:8px; color:var(--content-primary); font-size:var(--font-size-sm,12px); line-height:var(--line-height-ui,1.4); }
.mem-cleanup-uid:first-child { margin-top:0; }
.mem-cleanup-text { padding-left:4px; color:var(--content-secondary); font-size:var(--font-size-sm,12px); line-height:var(--line-height-body,1.6); }
.mem-cleanup-text.moved { color:var(--action-primary); }.mem-cleanup-text.profile-event { color:var(--status-warning); }.mem-cleanup-text.daily { color:var(--status-info); }.mem-cleanup-text.legacy { color:var(--content-tertiary); }
.im-memory-result { margin-top:12px; padding:12px; }.im-memory-result.memory-subpanel { padding: 12px; }.im-memory-summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }.im-memory-summary-grid > div { min-width:0; padding:10px 8px; border:1px solid var(--panel-glass-border); border-radius:var(--radius-sm); background:var(--surface-soft); text-align:center; }.im-memory-summary-grid strong { display:block; color:var(--content-primary); font-size:18px; line-height:1.2; }.im-memory-summary-grid span { display:block; margin-top:4px; color:var(--content-tertiary); font-size:11px; }.im-memory-platforms { display:flex; flex-wrap:wrap; gap:7px; margin-top:10px; }.im-memory-platform { padding:5px 9px; border-radius:var(--radius-pill); background:var(--selection-bg); color:var(--content-secondary); font-size:11px; }.im-memory-maintenance-actions { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; }.im-memory-progress { display:flex; gap:12px; margin-top:10px; color:var(--content-secondary); font-size:12px; }
.behavior-desc { color: var(--content-tertiary); font-size: 12px; }
.save-hint { color:var(--status-success); font-size:var(--font-size-sm,12px); line-height:var(--line-height-ui,1.4); }
.save-hint.error { color:var(--status-danger); }
.btn-ghost,.btn-primary { display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; min-height:30px; width:auto; padding:6px 14px; border-radius:var(--radius-sm); font-size:13px; line-height:1.2; cursor:pointer; white-space:nowrap; }
.btn-ghost { border:1px solid var(--border-subtle); background:var(--surface-glass); color:var(--content-secondary); }
.btn-ghost:hover:not(:disabled) { background:var(--surface-glass-hover); color:var(--content-primary); }
.btn-primary { border:0; background:var(--action-primary-bg); color:var(--content-on-accent); font-weight:600; box-shadow:none; }
.btn-primary:hover:not(:disabled) { background:var(--action-primary-bg-hover); }
.btn-ghost:disabled,.btn-primary:disabled { opacity:.5; cursor:default; }
@media (max-width:720px) { .im-memory-summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .result-head { align-items:flex-start; flex-direction:column; } }
</style>
