<template>
  <div v-if="ghostCount > 0" class="ghost-cleanup recon-block">
    <div class="ghost-cleanup__head recon-block-title">
      {{ t('storageAuditExtra.ghostRecords') }}
      <span class="recon-bulk">
        <ActionButton
          class="recon-act recon-act-del"
          variant="secondary"
          fit
          :disabled="disabled || running || !recordIds.length"
          @click="removeRecords(recordIds)"
        >
          <Icon name="action.delete" size="sm" />
          {{ t('storageAuditExtra.removeGhostRecords', { count: recordIds.length }) }}
        </ActionButton>
      </span>
    </div>

    <div v-if="progress" class="ghost-cleanup__progress" aria-live="polite">
      <div class="recon-meta">{{ t('storageAuditExtra.ghostCleanupProgress', progress) }}</div>
      <div
        class="ghost-cleanup__track"
        role="progressbar"
        :aria-label="t('storageAuditExtra.ghostCleanupProgressLabel')"
        :aria-valuemin="0"
        :aria-valuemax="progress.total"
        :aria-valuenow="progress.done"
      >
        <div class="ghost-cleanup__fill" :style="{ width: `${progress.done / progress.total * 100}%` }" />
      </div>
    </div>

    <div v-for="ghost in ghosts" :key="ghost.id" class="recon-row">
      <span class="recon-name">{{ ghost.name }}</span>
      <span class="recon-meta">
        {{ ghost.space }}{{ ghost.project ? ` · ${ghost.project}` : '' }}
        {{ ghost.deleted ? ` · ${t('storageAuditExtra.trash')}` : '' }} · {{ ghost.storage_key }}
      </span>
      <span class="recon-row-acts">
        <ActionButton
          class="recon-act recon-act-del"
          variant="secondary"
          fit
          :disabled="disabled || running"
          :title="t('storageAuditExtra.removeGhostRecordTitle')"
          @click="removeRecords([ghost.id])"
        >
          <Icon name="action.delete" size="sm" />{{ t('storageAuditExtra.removeGhostRecord') }}
        </ActionButton>
      </span>
    </div>

    <div class="recon-meta ghost-cleanup__hint">{{ t('storageAuditExtra.ghostCleanupHint') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { useAdminStore } from '@/stores/admin'

interface GhostRecord {
  id: number
  name: string
  space: string
  project: string | null
  deleted: boolean
  storage_key: string
}

const BATCH_SIZE = 300
const props = defineProps<{
  ghostCount: number
  ghosts: GhostRecord[]
  ghostIds?: number[]
  disabled?: boolean
}>()
const emit = defineEmits<{
  'busy-change': [busy: boolean]
  message: [message: { text: string; kind: 'ok' | 'err' }]
  refresh: [preserveMessage: boolean]
}>()

const { t } = useI18n()
const adminStore = useAdminStore()
const running = ref(false)
const progress = ref<{ done: number; total: number } | null>(null)
const recordIds = computed(() => [...new Set(
  props.ghostIds?.length ? props.ghostIds : props.ghosts.map(ghost => ghost.id),
)])

async function removeRecords(ids: number[]) {
  const uniqueIds = [...new Set(ids)]
  if (props.disabled || running.value || !uniqueIds.length) return
  if (!await confirmDialog({
    title: t('storageAuditExtra.removeGhostTitle'),
    message: t('storageAuditExtra.removeGhostConfirm', { count: uniqueIds.length }),
    tone: 'danger',
    confirmText: t('storageAuditExtra.removeGhostRecord'),
  })) return

  running.value = true
  emit('busy-change', true)
  const batches = Array.from(
    { length: Math.ceil(uniqueIds.length / BATCH_SIZE) },
    (_, index) => uniqueIds.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
  )
  if (batches.length > 1) progress.value = { done: 0, total: uniqueIds.length }

  let doneCount = 0
  let failedCount = 0
  let processedCount = 0
  try {
    for (const batch of batches) {
      const response = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/ghosts/repair', {
        method: 'POST',
        body: JSON.stringify({ file_ids: batch, confirm: true }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || t('storageAuditExtra.repairFailure', { message: '' }))
      doneCount += Array.isArray(data.done) ? data.done.length : 0
      failedCount += Array.isArray(data.failed) ? data.failed.length : 0
      processedCount += batch.length
      if (progress.value) progress.value.done = processedCount
    }
    emit('message', {
      kind: failedCount ? 'err' : 'ok',
      text: t('storageAuditExtra.ghostRepairResult', { done: doneCount, failed: failedCount }),
    })
    emit('refresh', true)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    emit('message', {
      kind: 'err',
      text: processedCount > 0 || failedCount > 0
        ? t('storageAuditExtra.ghostRepairInterrupted', {
          done: doneCount,
          failed: failedCount,
          remaining: uniqueIds.length - processedCount,
          message: detail,
        })
        : t('storageAuditExtra.repairFailure', { message: detail }),
    })
    if (processedCount > 0) emit('refresh', true)
  } finally {
    progress.value = null
    running.value = false
    emit('busy-change', false)
  }
}
</script>

<style scoped>
.recon-block { margin-top: 10px; }
.recon-block-title { font-weight: var(--font-weight-semibold); margin-bottom: 4px; color: var(--content-primary); }
.recon-row { padding: 4px 0; border-top: 1px solid var(--panel-divider); display: flex; gap: 8px; align-items: center; }
.recon-name { font-weight: var(--font-weight-semibold); color: var(--content-primary); }
.recon-meta { color: var(--content-secondary); word-break: break-all; flex: 1; min-width: 0; }
.recon-row-acts, .recon-bulk { display: inline-flex; gap: 6px; flex-shrink: 0; margin-left: 8px; }
.recon-act { font-size: var(--font-size-xs); }
.app-action-button.recon-act-del { border-color: color-mix(in srgb, var(--status-danger) 40%, transparent); color: var(--status-danger); }
.ghost-cleanup__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ghost-cleanup__progress { display: grid; gap: 6px; margin: 8px 0 10px; }
.ghost-cleanup__track { height: var(--progress-track-height); overflow: hidden; border-radius: var(--progress-track-radius); background: var(--progress-track-bg); }
.ghost-cleanup__fill { height: 100%; border-radius: inherit; background: var(--progress-fill-bg); transition: width 0.2s ease; }
.ghost-cleanup__hint { margin-top: 6px; }
</style>
