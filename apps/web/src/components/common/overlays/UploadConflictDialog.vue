<template>
  <BaseModal :show="open" width="480px" background="var(--panel-bg)" @close="cancel">
    <div class="ucd">
      <div class="ucd-header">
        <h2>{{ t('viewerUi.conflictTitle', { count: conflicts.length }) }}</h2>
        <button class="close-btn" @click="cancel">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M3 3l10 10M13 3L3 13"/>
          </svg>
        </button>
      </div>

      <div class="ucd-bulk">
        <span class="ucd-bulk-label">{{ t('viewerUi.all') }}：</span>
        <button class="ucd-bulk-btn" @click="applyAll('overwrite')">{{ t('viewerUi.overwrite') }}</button>
        <button class="ucd-bulk-btn" @click="applyAll('keep_both')">{{ t('viewerUi.keepBoth') }}</button>
        <button class="ucd-bulk-btn" @click="applyAll('skip')">{{ t('viewerUi.skip') }}</button>
      </div>

      <div class="ucd-list">
        <div v-for="c in conflicts" :key="c.filename" class="ucd-item">
          <span class="ucd-name" :title="c.filename">{{ c.filename }}</span>
          <div class="ucd-choices">
            <label class="ucd-radio" :class="{ active: choices[c.filename] === 'overwrite' }">
              <input type="radio" :name="c.filename" value="overwrite" v-model="choices[c.filename]" />{{ t('viewerUi.overwrite') }}
            </label>
            <label class="ucd-radio" :class="{ active: choices[c.filename] === 'keep_both' }">
              <input type="radio" :name="c.filename" value="keep_both" v-model="choices[c.filename]" />{{ t('viewerUi.keepBoth') }}
            </label>
            <label class="ucd-radio" :class="{ active: choices[c.filename] === 'skip' }">
              <input type="radio" :name="c.filename" value="skip" v-model="choices[c.filename]" />{{ t('viewerUi.skip') }}
            </label>
          </div>
        </div>
      </div>

      <div class="ucd-footer">
        <button class="btn-cancel" @click="cancel">{{ t('viewerUi.cancelUpload') }}</button>
        <button class="btn-confirm" @click="confirm">{{ t('common.actions.confirm') }}</button>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

export interface ConflictItem {
  filename: string
  existingFile?: { id: number } | null
}
export interface ConflictDecision {
  action: 'overwrite' | 'keep_both' | 'skip'
  existingFileId?: number
}

const open = ref(false)
const conflicts = ref<ConflictItem[]>([])
const choices = reactive<Record<string, string>>({})
let _resolve: ((m: Map<string, ConflictDecision>) => void) | null = null

// 有冲突时弹出列表式确认，返回一个 Promise：resolve 出每个文件名 -> 决定（覆盖/保留两者/跳过）。
// 没有冲突的文件不会经过这个弹窗，宿主直接按 keep_both 处理即可。
function show(list: ConflictItem[]): Promise<Map<string, ConflictDecision>> {
  conflicts.value = list
  for (const c of list) choices[c.filename] = 'keep_both'
  open.value = true
  return new Promise(resolve => { _resolve = resolve })
}

function applyAll(action: string) {
  for (const c of conflicts.value) choices[c.filename] = action
}

function _buildMap(): Map<string, ConflictDecision> {
  return new Map(conflicts.value.map(c => [
    c.filename,
    { action: choices[c.filename] as ConflictDecision['action'], existingFileId: c.existingFile?.id },
  ]))
}

function confirm() {
  open.value = false
  _resolve?.(_buildMap())
}

function cancel() {
  open.value = false
  // 取消 = 这批冲突文件全部跳过，不上传（不影响本来就没冲突的其它文件）
  _resolve?.(new Map(conflicts.value.map(c => [c.filename, { action: 'skip' as const }])))
}

defineExpose({ show })
</script>

<style scoped>
.ucd { display: flex; flex-direction: column; max-height: 70vh; }

.ucd-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px 14px;
  border-bottom: 1px solid var(--panel-divider);
  flex-shrink: 0;
}
.ucd-header h2 { font-size: 15px; font-weight: 700; }

.close-btn {
  width: 28px; height: 28px; border-radius: 8px;
  background: var(--control-bg); border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-secondary);
  transition: background 0.15s;
}
.close-btn:hover { background: var(--control-bg-hover); }

.ucd-bulk {
  display: flex; align-items: center; gap: 6px;
  padding: 12px 24px; flex-shrink: 0;
  border-bottom: 1px solid var(--panel-divider);
}
.ucd-bulk-label { font-size: 11px; color: var(--text-secondary); margin-right: 2px; }
.ucd-bulk-btn {
  padding: 4px 10px; border-radius: 20px;
  border: 1px solid var(--control-border);
  background: var(--control-bg);
  font-size: 11px; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans);
  transition: all 0.15s;
}
.ucd-bulk-btn:hover { background: var(--action-soft-hover); color: var(--action-primary); border-color: var(--action-outline); }

.ucd-list {
  flex: 1; overflow-y: auto;
  padding: 10px 24px; display: flex; flex-direction: column; gap: 6px;
}
.ucd-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 10px; border-radius: 10px;
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
}
.ucd-name {
  flex: 1; min-width: 0; font-size: 12px; font-weight: 500; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ucd-choices { display: flex; gap: 4px; flex-shrink: 0; }
.ucd-radio {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: 8px;
  font-size: 11px; color: var(--text-secondary);
  cursor: pointer; user-select: none;
  border: 1px solid transparent;
  transition: all 0.12s;
}
.ucd-radio input { width: 11px; height: 11px; accent-color: var(--action-primary); }
.ucd-radio.active { background: var(--action-soft); color: var(--action-primary); border-color: var(--action-outline); }

.ucd-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 14px 24px;
  border-top: 1px solid var(--panel-divider);
  flex-shrink: 0;
}
.btn-cancel {
  padding: 8px 18px; border-radius: var(--radius-sm);
  border: 1px solid var(--control-border);
  background: var(--control-bg);
  font-size: 13px; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans);
  transition: all 0.15s;
}
.btn-cancel:hover { background: var(--control-bg-hover); color: var(--content-primary); }
.btn-confirm {
  padding: 8px 22px; border-radius: var(--radius-sm);
  background: var(--action-primary-bg);
  border: none; color: var(--content-on-accent);
  font-size: 13px; font-weight: 600;
  cursor: pointer; font-family: var(--font-sans);
  box-shadow: none;
  transition: background-color 0.15s;
}
.btn-confirm:hover { background: var(--action-primary-bg-hover); opacity: 1; }
</style>
