<template>
  <button
    class="undo-history-trigger"
    type="button"
    :aria-label="t('undoHistory.open')"
    :title="t('undoHistory.open')"
    @click="open = true"
  >
    <span aria-hidden="true">↶</span>
    <span>{{ t('undoHistory.shortTitle') }}</span>
  </button>

  <BaseModal :show="open" width="520px" background="var(--panel-bg)" @close="open = false">
    <section class="undo-history" aria-labelledby="undo-history-title">
      <header class="undo-history__header">
        <div>
          <h2 id="undo-history-title">{{ t('undoHistory.title') }}</h2>
          <p>{{ t('undoHistory.description') }}</p>
        </div>
        <div class="undo-history__header-actions">
          <button class="undo-history__refresh" type="button" :disabled="loading" :aria-label="t('undoHistory.refresh')" @click="load">
            {{ t('undoHistory.refresh') }}
          </button>
          <CloseButton :title="t('common.actions.close')" @click="open = false" />
        </div>
      </header>

      <div v-if="stats" class="undo-history__stats" aria-live="polite">
        {{ t('undoHistory.stats', { total: stats.total, active: stats.by_status.active, undone: stats.by_status.undone }) }}
      </div>

      <div v-if="loading" class="undo-history__empty">{{ t('common.status.loading') }}</div>
      <div v-else-if="error" class="undo-history__empty undo-history__empty--error">{{ error }}</div>
      <div v-else-if="items.length === 0" class="undo-history__empty">{{ t('undoHistory.empty') }}</div>
      <ul v-else class="undo-history__list">
        <li v-for="item in items" :key="item.operation_id" class="undo-history__item">
          <div class="undo-history__item-main">
            <strong>{{ itemLabel(item) }}</strong>
            <span>{{ formatTime(item.created_at) }}</span>
            <small>{{ statusLabel(item.status) }}</small>
          </div>
          <div class="undo-history__item-actions">
            <ActionButton
              v-if="item.can_undo"
              variant="secondary"
              fit
              :disabled="busyId === item.operation_id"
              @click="apply(item, 'undo')"
            >{{ t('undoHistory.undo') }}</ActionButton>
            <ActionButton
              v-else-if="item.can_redo"
              variant="secondary"
              fit
              :disabled="busyId === item.operation_id"
              @click="apply(item, 'redo')"
            >{{ t('undoHistory.redo') }}</ActionButton>
          </div>
        </li>
      </ul>
    </section>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import CloseButton from '@/components/common/overlays/CloseButton.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { undoApi, type UndoHistoryEntry, type UndoStats } from '@/services/api'

const { t, locale } = useI18n()
const open = ref(false)
const loading = ref(false)
const error = ref('')
const items = ref<UndoHistoryEntry[]>([])
const stats = ref<UndoStats | null>(null)
const busyId = ref<string | null>(null)

const resourceLabels: Record<string, string> = {
  files: 'undoHistory.resources.files', projects: 'undoHistory.resources.projects',
  calendar: 'undoHistory.resources.calendar', mind: 'undoHistory.resources.mind',
}
const actionLabels: Record<string, string> = {
  create: 'undoHistory.actions.create', update: 'undoHistory.actions.update',
  delete: 'undoHistory.actions.delete', move: 'undoHistory.actions.move',
  rename: 'undoHistory.actions.rename', overwrite: 'undoHistory.actions.overwrite',
  copy: 'undoHistory.actions.copy', append: 'undoHistory.actions.append',
}

function itemLabel(item: UndoHistoryEntry): string {
  const resource = t(resourceLabels[item.resource] ?? 'undoHistory.resources.other')
  const action = t(actionLabels[item.action] ?? 'undoHistory.actions.update')
  return t('undoHistory.item', { resource, action, count: item.target_count })
}

function statusLabel(status: UndoHistoryEntry['status']): string {
  return t(`undoHistory.status.${status}`)
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [history, currentStats] = await Promise.all([undoApi.history(), undoApi.stats()])
    items.value = history.items
    stats.value = currentStats
  } catch (cause) {
    error.value = errorMessage(cause, t('undoHistory.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function apply(item: UndoHistoryEntry, mode: 'undo' | 'redo'): Promise<void> {
  if (busyId.value) return
  busyId.value = item.operation_id
  try {
    if (mode === 'undo') await undoApi.undo(item.operation_id)
    else await undoApi.redo(item.operation_id)
    showAppNotice(t(mode === 'undo' ? 'errors.undoCompleted' : 'errors.redoCompleted'))
    await load()
  } catch (cause) {
    showAppError(errorMessage(cause, t('errors.undoFailed')))
    await load()
  } finally {
    busyId.value = null
  }
}

watch(open, value => { if (value) void load() })
</script>

<style scoped>
.undo-history-trigger {
  position: fixed;
  right: 24px;
  bottom: 76px;
  z-index: 9000;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 7px 10px;
  border: 1px solid var(--control-border);
  border-radius: var(--radius-sm);
  background: var(--control-bg);
  color: var(--content-secondary);
  box-shadow: var(--elevation-card);
  cursor: pointer;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard), transform var(--motion-hover-control) var(--motion-ease-standard);
}
.undo-history-trigger:hover { background: var(--control-bg-hover); color: var(--content-primary); transform: translateY(-1px); }
.undo-history-trigger:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.undo-history { display: flex; flex-direction: column; min-height: 240px; max-height: min(620px, calc(100vh - 96px)); color: var(--content-primary); }
.undo-history__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 20px 14px; border-bottom: 1px solid var(--border-subtle); }
.undo-history__header h2 { margin: 0; font-size: 18px; }
.undo-history__header p { margin: 5px 0 0; color: var(--content-secondary); font-size: 12px; }
.undo-history__header-actions { display: inline-flex; align-items: center; gap: 8px; }
.undo-history__refresh { border: 0; background: transparent; color: var(--content-secondary); cursor: pointer; font: inherit; }
.undo-history__refresh:hover:not(:disabled) { color: var(--content-primary); }
.undo-history__refresh:disabled { opacity: .5; cursor: default; }
.undo-history__stats { padding: 10px 20px; color: var(--content-secondary); font-size: 12px; background: color-mix(in srgb, var(--control-bg) 60%, transparent); }
.undo-history__list { overflow: auto; margin: 0; padding: 4px 20px 16px; list-style: none; }
.undo-history__item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--border-subtle); }
.undo-history__item-main { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.undo-history__item-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.undo-history__item-main span, .undo-history__item-main small { color: var(--content-secondary); font-size: 11px; }
.undo-history__item-actions { flex: 0 0 auto; }
.undo-history__empty { display: grid; min-height: 180px; place-items: center; padding: 20px; color: var(--content-secondary); font-size: 13px; }
.undo-history__empty--error { color: var(--content-danger, #b45a5a); }
</style>
