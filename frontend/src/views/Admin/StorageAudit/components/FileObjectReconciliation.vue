<template>
  <section class="sa-card file-audit-group">
    <div class="sa-card-head">
      <div>
        <h3 class="sa-card-title">{{ t('storageAudit.fileAudit') }}</h3>
        <p class="sa-card-sub">{{ t('storageAudit.fileAuditHint') }}</p>
      </div>
      <ActionButton variant="secondary" fit :disabled="scanning" @click="scan()">
        <Icon name="action.search" size="sm" />
        {{ scanning ? t('storageAudit.scanning') : t('storageAudit.scan') }}
      </ActionButton>
    </div>

    <div v-if="message" class="sa-inline-msg" :class="messageKind">{{ message }}</div>
    <div v-if="report" class="file-audit-report">
      <div v-if="report.error" class="recon-err">{{ t('storageAudit.fileAudit') }}：{{ report.error }}</div>
      <template v-else>
        <div class="recon-summary">
          {{ t('storageAuditExtra.storage') }} <b>{{ report.backend }}</b>（{{ report.location }}） ·
          {{ t('storageAuditExtra.dbFiles') }} <b>{{ report.db_file_rows }}</b> ·
          {{ t('storageAuditExtra.objects') }} <b>{{ report.storage_objects }}</b> ·
          {{ t('storageAuditExtra.matched') }} <b class="status-success-text">{{ report.matched }}</b>
        </div>

        <div class="file-audit-grid">
          <section class="fd-section">
            <div class="fd-section-head">
              <div class="sec-title miss">{{ t('storageAuditExtra.ghostRecords') }}</div>
              <div class="fd-count" :class="{ 'status-danger-text': report.ghost_count }">{{ report.ghost_count }}</div>
            </div>
            <GhostRecordCleanup
              v-if="report.ghost_count"
              :ghost-count="report.ghost_count"
              :ghost-ids="report.ghost_ids"
              :ghosts="report.ghosts || []"
              :disabled="repairing"
              @busy-change="repairing = $event"
              @message="setMessage"
              @refresh="scan($event)"
            />
            <div v-else class="fd-empty">{{ t('storageAuditExtra.noGhostRecords') }}</div>
          </section>

          <section class="fd-section">
            <div class="fd-section-head">
              <div class="sec-title orphan">{{ t('storageAuditExtra.orphanFiles') }}</div>
              <div class="fd-count" :class="{ 'status-warning-text': report.orphan_count }">{{ report.orphan_count }}</div>
            </div>
            <template v-if="report.orphan_count">
              <div class="fd-actions fd-actions-top">
                <ActionButton class="recon-act" variant="secondary" fit :disabled="repairing" @click="repairOrphans(report.orphans, 'import')">
                  <Icon name="action.upload" size="sm" />{{ t('storageAuditExtra.importAll') }}
                </ActionButton>
                <ActionButton class="recon-act recon-act-del" variant="secondary" fit :disabled="repairing" @click="repairOrphans(report.orphans, 'delete')">
                  <Icon name="action.delete" size="sm" />{{ t('storageAuditExtra.deleteAll') }}
                </ActionButton>
              </div>
              <ul class="dir-list">
                <li v-for="key in report.orphans" :key="key" class="dir-item orphan-file-item">
                  <span>{{ key }}</span>
                  <span class="row-actions">
                    <ActionButton class="recon-act" variant="secondary" fit :disabled="repairing" :title="t('storageAuditExtra.importTitle')" @click="repairOrphans([key], 'import')">
                      <Icon name="action.upload" size="sm" />{{ t('storageAuditExtra.import') }}
                    </ActionButton>
                    <ActionButton class="recon-act recon-act-del" variant="secondary" fit :disabled="repairing" :title="t('storageAuditExtra.deleteTitle')" @click="repairOrphans([key], 'delete')">
                      <Icon name="action.delete" size="sm" />{{ t('storageAuditExtra.delete') }}
                    </ActionButton>
                  </span>
                </li>
              </ul>
            </template>
            <div v-else class="fd-empty">{{ t('storageAuditExtra.noOrphanFiles') }}</div>
          </section>
        </div>

        <div v-if="!report.ghost_count && !report.orphan_count" class="fd-banner ok">
          <Icon name="status.check-circle" size="md" />{{ t('storageAuditExtra.filesHealthy') }}
        </div>
        <div v-if="report.truncated" class="recon-meta truncated-note">{{ t('storageAuditExtra.truncated') }}</div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { useAdminStore } from '@/stores/admin'
import GhostRecordCleanup from './GhostRecordCleanup.vue'

interface FileAuditReport {
  error?: string
  backend: string
  location: string
  db_file_rows: number
  storage_objects: number
  matched: number
  ghost_count: number
  ghost_ids: number[]
  ghosts: Array<{ id: number; name: string; space: string; project: string | null; deleted: boolean; storage_key: string }>
  orphan_count: number
  orphans: string[]
  truncated: boolean
}

const adminStore = useAdminStore()
const { t } = useI18n()
const scanning = ref(false)
const repairing = ref(false)
const report = ref<FileAuditReport | null>(null)
const message = ref('')
const messageKind = ref<'ok' | 'err'>('ok')

function setMessage(next: { text: string; kind: 'ok' | 'err' }) {
  message.value = next.text
  messageKind.value = next.kind
}

async function scan(preserveMessage = false) {
  if (scanning.value) return
  scanning.value = true
  if (!preserveMessage) message.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage')
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || t('storageAuditExtra.auditFailed', { message: '' }))
    report.value = data
  } catch (error) {
    report.value = {
      error: error instanceof Error ? error.message : String(error),
      backend: '', location: '', db_file_rows: 0, storage_objects: 0, matched: 0,
      ghost_count: 0, ghost_ids: [], ghosts: [], orphan_count: 0, orphans: [], truncated: false,
    }
  } finally {
    scanning.value = false
  }
}

async function repairOrphans(keys: string[], action: 'import' | 'delete') {
  if (repairing.value || !keys.length) return
  if (action === 'delete' && !await confirmDialog({
    title: t('storageAuditExtra.orphanDeleteTitle'),
    message: t('storageAuditExtra.orphanDeleteConfirm', { count: keys.length }),
    tone: 'danger',
    confirmText: t('storageAuditExtra.permanentDelete'),
  })) return

  repairing.value = true
  message.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/repair', {
      method: 'POST',
      body: JSON.stringify({ action, keys, confirm: true }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || t('storageAuditExtra.repairFailure', { message: '' }))
    const doneKeys = new Set<string>(data.done_keys || [])
    if (report.value) {
      report.value.orphans = report.value.orphans.filter(key => !doneKeys.has(key))
      report.value.orphan_count = report.value.orphans.length
    }
    if (data.failed?.length) {
      messageKind.value = 'err'
      message.value = t('storageAuditExtra.repairResult', { done: data.done, failed: data.failed.length }) + ': ' + data.failed.map((failure: { key: string; error: string }) => `${failure.key}: ${failure.error}`).join('；')
    } else {
      messageKind.value = 'ok'
      message.value = t('storageAuditExtra.repaired', { count: data.done, action: action === 'import' ? t('storageAuditExtra.actionImport') : t('storageAuditExtra.actionDelete') })
    }
  } catch (error) {
    messageKind.value = 'err'
    message.value = t('storageAuditExtra.repairFailure', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    repairing.value = false
  }
}

defineExpose({ scan })
</script>

<style scoped>
.file-audit-group { margin-bottom: 20px; }
.sa-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 20px 22px; margin-bottom: 20px; }
.sa-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.file-audit-group > .sa-card-head { align-items: center; }
.sa-card-title { font-size: var(--font-size-md); font-weight: var(--font-weight-bold); margin: 0; }
.sa-card-sub { font-size: var(--font-size-sm); color: var(--content-secondary); margin: 4px 0 0; max-width: 560px; }
.sa-inline-msg { font-size: var(--font-size-sm); margin-bottom: 10px; padding: 8px 12px; border-radius: 8px; }
.sa-inline-msg.ok { color: var(--status-success); background: var(--status-success-bg); border: 1px solid color-mix(in srgb, var(--status-success) 22%, transparent); }
.sa-inline-msg.err { color: var(--status-danger); background: var(--status-danger-bg); border: 1px solid color-mix(in srgb, var(--status-danger) 25%, transparent); }
.file-audit-report { display: grid; gap: 12px; font-size: var(--font-size-sm); }
.recon-summary { line-height: var(--line-height-body); color: var(--content-primary); padding: 8px 0 12px; border-bottom: 1px solid var(--panel-divider); }
.recon-summary b { font-weight: var(--font-weight-bold); }
.recon-err { color: var(--status-danger); font-weight: var(--font-weight-semibold); }
.recon-meta { color: var(--content-secondary); word-break: break-all; }
.status-success-text { color: var(--status-success); }
.status-danger-text { color: var(--status-danger); }
.status-warning-text { color: var(--status-warning); }
.file-audit-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.fd-section { min-width: 0; border: 1px solid var(--panel-divider); border-radius: 12px; padding: 14px; background: rgba(255,255,255,0.02); }
.fd-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.fd-section-head .sec-title { margin: 0; }
.fd-count { font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); }
.fd-banner { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-size: var(--font-size-sm); }
.fd-banner.ok { background: var(--status-success-bg); border: 1px solid color-mix(in srgb, var(--status-success) 25%, transparent); color: var(--status-success); }
.sec-title { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); margin-bottom: 10px; }
.sec-title.miss { color: var(--status-info); }
.sec-title.orphan { color: var(--status-warning); }
.fd-empty { color: var(--content-secondary); font-size: var(--font-size-sm); padding: 8px 0; }
.dir-list { list-style: none; margin: 0; padding: 8px; max-height: 240px; overflow-y: auto; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
.orphan-file-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--panel-divider); }
.dir-item { font-family: var(--font-mono); font-size: var(--font-size-sm); color: var(--content-primary); padding: 6px 8px; word-break: break-all; }
.row-actions { display: inline-flex; gap: 6px; flex: 0 0 auto; }
.fd-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fd-actions-top { margin-bottom: 8px; }
.recon-act { font-size: var(--font-size-xs); }
.app-action-button.recon-act-del { border-color: color-mix(in srgb, var(--status-danger) 40%, transparent); color: var(--status-danger); }
.truncated-note { margin-top: 0; }
@media (max-width: 760px) { .sa-card-head { flex-wrap: wrap; } .orphan-file-item { align-items: flex-start; flex-direction: column; } }
</style>
