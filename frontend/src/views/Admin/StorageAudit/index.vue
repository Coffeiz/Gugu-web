<template>
  <div class="sa-page">
    <div class="sa-head">
      <h2 class="sa-title">{{ t('admin.storageAudit') }}</h2>
      <p class="sa-sub">{{ t('storageAudit.subtitle') }}</p>
    </div>

    <FileSyncAdminPanel />

    <section class="sa-card user-storage-audit">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">{{ t('storageAuditUi.userTitle') }}</h3>
          <p class="sa-card-sub">{{ t('storageAuditUi.userHint') }}</p>
        </div>
        <div class="sa-card-head-right">
          <ActionButton variant="secondary" fit :disabled="userScanning" @click="scanUsers">
            <Icon name="action.search" size="sm" />
            {{ userScanning ? t('storageAuditUi.userScanning') : t('storageAuditUi.userScan') }}
          </ActionButton>
          <ActionButton v-if="userReport?.users.length" fit :disabled="userCleaning" @click="cleanUsers">
            <Icon name="action.delete" size="sm" />
            {{ t('storageAuditUi.userClean', { count: userReport.users.length }) }}
          </ActionButton>
        </div>
      </div>
      <div v-if="userMsg" class="sa-inline-msg" :class="userMsgKind">{{ userMsg }}</div>
      <div v-if="userReport" class="recon-report">
        <div class="recon-summary">
          {{ t('storageAuditUi.userSummary', { total: userReport.user_count, missing: userReport.missing_directory_count, empty: userReport.missing_file_user_count }) }}
          <span class="recon-meta"> · {{ userReport.location }}</span>
        </div>
        <div v-if="!userReport.users.length" class="recon-ok"><RiCheckFill class="recon-ok__icon" aria-hidden="true" />{{ t('storageAuditUi.userHealthy') }}</div>
        <div v-else class="recon-block">
          <div class="recon-block-title">{{ t('storageAuditUi.userMissing') }}</div>
          <div v-for="u in userReport.users" :key="u.user_id" class="recon-row">
            <span class="recon-name">{{ u.display_name || u.username }}</span>
            <span class="recon-meta">{{ u.username }} · {{ u.user_id }} · {{ t(u.reason === 'missing_directory' ? 'storageAuditUi.userReasonDirectory' : 'storageAuditUi.userReasonFiles') }} · {{ t('storageAuditUi.userImpact', { files: u.files, physical: u.physical_files, projects: u.projects, tasks: u.scheduled_tasks }) }}</span>
          </div>
          <p class="sa-card-sub user-storage-warning">{{ t('storageAuditUi.userWarning') }}</p>
        </div>
      </div>
    </section>

    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">{{ t('storageAuditUi.legacyTitle') }}</h3>
          <p class="sa-card-sub">{{ t('storageAuditUi.legacyHint') }}</p>
        </div>
        <div class="sa-card-head-right">
          <ActionButton variant="secondary" fit :disabled="trashMigrating" @click="scanTrashMigration"><Icon name="action.search" size="sm" />{{ t('storageAudit.scanLegacyTrash') }}</ActionButton>
          <ActionButton v-if="trashMigration?.items?.length" fit :disabled="trashMigrating" @click="runTrashMigration"><Icon name="action.refresh" size="sm" />{{ t('storageAudit.migrateItems', { count: trashMigration.items.length }) }}</ActionButton>
        </div>
      </div>
      <div v-if="trashMigrationMsg" class="sa-inline-msg" :class="trashMigrationKind">{{ trashMigrationMsg }}</div>
      <div v-if="trashMigration" class="recon-summary">
        <template v-if="trashMigration.note">{{ trashMigration.note }}</template>
        <template v-else>{{ t('storageAudit.legacyFound', { count: trashMigration.count }) }}</template>
      </div>
    </section>

    <!-- ══ 文件对账：存储对象 ↔ File 记录 ══ -->
    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">{{ t('storageAudit.fileAudit') }}</h3>
          <p class="sa-card-sub">{{ t('storageAudit.fileAuditHint') }}</p>
        </div>
          <ActionButton variant="secondary" fit :disabled="fileScanning" @click="scanFiles">
          <Icon name="action.search" size="sm" />
          {{ fileScanning ? t('storageAudit.scanning') : t('storageAudit.scan') }}
        </ActionButton>
      </div>

      <div v-if="fileMsg" class="sa-inline-msg" :class="fileMsgKind">{{ fileMsg }}</div>

      <div v-if="fileReport" class="recon-report">
          <div v-if="fileReport.error" class="recon-err">{{ t('storageAudit.fileAudit') }}：{{ fileReport.error }}</div>
        <template v-else>
          <div class="recon-summary">
            {{ t('storageAuditExtra.storage') }} <b>{{ fileReport.backend }}</b>（{{ fileReport.location }}） ·
            {{ t('storageAuditExtra.dbFiles') }} <b>{{ fileReport.db_file_rows }}</b> · {{ t('storageAuditExtra.objects') }} <b>{{ fileReport.storage_objects }}</b> ·
            {{ t('storageAuditExtra.matched') }} <b class="status-success-text">{{ fileReport.matched }}</b> ·
            {{ t('storageAuditExtra.ghosts') }} <b :class="{ 'status-danger-text': fileReport.ghost_count }">{{ fileReport.ghost_count }}</b> ·
            {{ t('storageAuditExtra.orphans') }} <b :class="{ 'status-warning-text': fileReport.orphan_count }">{{ fileReport.orphan_count }}</b> ·
            {{ t('storageAuditExtra.misplaced') }} <b :class="{ 'status-warning-text': fileReport.misplaced_count }">{{ fileReport.misplaced_count || 0 }}</b>
          </div>
          <div v-if="!fileReport.ghost_count && !fileReport.orphan_count && !fileReport.misplaced_count" class="recon-ok"><RiCheckFill class="recon-ok__icon" aria-hidden="true" />{{ t('storageAuditUi.healthy') }}</div>
          <div v-if="fileReport.ghost_count" class="recon-block">
            <div class="recon-block-title">{{ t('storageAuditExtra.ghostRecords') }}</div>
            <div v-for="g in fileReport.ghosts" :key="g.id" class="recon-row">
              <span class="recon-name">{{ g.name }}</span>
              <span class="recon-meta">{{ g.space }}{{ g.project ? ' · ' + g.project : '' }}{{ g.deleted ? ' · ' + t('storageAuditExtra.trash') : '' }} · {{ g.storage_key }}</span>
            </div>
          </div>
          <div v-if="fileReport.orphan_count" class="recon-block">
            <div class="recon-block-title">
              {{ t('storageAuditExtra.orphanFiles') }}
              <span class="recon-bulk">
                <ActionButton class="recon-act" variant="secondary" fit :disabled="fileRepairing" @click="repairOrphans(fileReport.orphans, 'import')"><Icon name="action.upload" size="sm" />{{ t('storageAuditExtra.importAll') }}</ActionButton>
                <ActionButton class="recon-act recon-act-del" variant="secondary" fit :disabled="fileRepairing" @click="repairOrphans(fileReport.orphans, 'delete')"><Icon name="action.delete" size="sm" />{{ t('storageAuditExtra.deleteAll') }}</ActionButton>
              </span>
            </div>
            <div v-for="o in fileReport.orphans" :key="o" class="recon-row">
              <span class="recon-meta">{{ o }}</span>
              <span class="recon-row-acts">
                <ActionButton class="recon-act" variant="secondary" fit :disabled="fileRepairing" @click="repairOrphans([o], 'import')" :title="t('storageAuditExtra.importTitle')"><Icon name="action.upload" size="sm" />{{ t('storageAuditExtra.import') }}</ActionButton>
                <ActionButton class="recon-act recon-act-del" variant="secondary" fit :disabled="fileRepairing" @click="repairOrphans([o], 'delete')" :title="t('storageAuditExtra.deleteTitle')"><Icon name="action.delete" size="sm" />{{ t('storageAuditExtra.delete') }}</ActionButton>
              </span>
            </div>
          </div>
          <div v-if="fileReport.misplaced_count" class="recon-block">
            <div class="recon-block-title">
              {{ t('storageAuditExtra.misplacedHint') }}
              <span class="recon-bulk">
                <ActionButton class="recon-act" variant="secondary" fit :disabled="fileRepairing" @click="repairMisplaced"><Icon name="action.refresh" size="sm" />{{ t('storageAuditExtra.moveAll') }}</ActionButton>
              </span>
            </div>
            <div v-for="item in fileReport.misplaced_files" :key="item.file_id" class="recon-row">
              <span class="recon-name">{{ item.display_name }}</span>
              <span class="recon-meta">{{ item.current_key }} → {{ item.expected_key }}</span>
            </div>
          </div>
          <div v-if="fileReport.truncated" class="recon-meta">{{ t('storageAuditExtra.truncated') }}</div>
        </template>
      </div>
    </section>

    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">{{ t('storageAuditUi.pathTitle') }}</h3>
          <p class="sa-card-sub">{{ t('storageAuditUi.pathHint') }}</p>
        </div>
        <div class="sa-card-head-right">
          <ActionButton variant="secondary" fit :disabled="pathScanning" @click="scanPathMigration"><Icon name="action.search" size="sm" />{{ t('storageAuditUi.scanPath') }}</ActionButton>
          <ActionButton v-if="pathReport?.candidates?.length" fit :disabled="pathRepairing" @click="repairPathMigration">
            <Icon name="admin.wrench" size="sm" />
            {{ t('storageAuditUi.repairItems', { count: pathReport.candidates.length }) }}
          </ActionButton>
        </div>
      </div>
      <div v-if="pathMsg" class="sa-inline-msg" :class="pathMsgKind">{{ pathMsg }}</div>
      <div v-if="pathReport" class="recon-report">
        <div class="recon-summary">{{ t('storageAuditExtra.safeMatch') }} {{ t('filesViewUi.items', { count: pathReport.candidate_count }) }} · {{ t('storageAuditExtra.ambiguous') }} {{ t('filesViewUi.items', { count: pathReport.ambiguous_count }) }}</div>
        <div v-if="pathReport.ambiguous_count" class="recon-meta">{{ t('storageAuditExtra.ambiguousHint') }}</div>
        <div v-for="item in pathReport.candidates" :key="item.file_id" class="recon-row">
          <span class="recon-name">{{ item.name }}</span>
          <span class="recon-meta">{{ item.expected_old_key }} → {{ item.key }}</span>
        </div>
      </div>
    </section>

    <!-- ══ 目录对账：文件夹树 ↔ 磁盘目录 ══ -->
    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">{{ t('storageAuditUi.dirTitle') }}</h3>
          <p class="sa-card-sub">{{ t('storageAuditUi.dirHint') }}</p>
        </div>
        <div class="sa-card-head-right">
          <input v-model.trim="userId" class="sa-input" :placeholder="t('storageAuditUi.userId')" @keyup.enter="scanDirs()" />
          <ActionButton variant="secondary" fit :disabled="dirScanning" @click="scanDirs()">
            <Icon name="action.search" size="sm" />
            {{ dirScanning ? t('storageAuditUi.reconciling') : t('storageAudit.scan') }}
          </ActionButton>
        </div>
      </div>

      <div v-if="dirErr" class="sa-inline-msg err">{{ dirErr }}</div>

      <template v-if="dirReport">
        <div class="fd-banner" :class="dirReport.healthy ? 'ok' : 'alert'">
          <Icon v-if="dirReport.healthy" name="status.check-circle" size="md" />
          <Icon v-else name="status.warning" size="md" />
          <span v-if="dirReport.healthy">{{ t('storageAuditUi.healthy') }}</span>
          <span v-else>
            {{ t('storageAuditExtra.found') }}
            <b v-if="dirReport.missing_dirs.length">{{ t('storageAuditExtra.missingCount', { count: dirReport.missing_dirs.length }) }}</b>
            <span v-if="dirReport.missing_dirs.length && (dirReport.orphan_dirs.length || dirReport.misplaced_files.length)">、</span>
            <b v-if="dirReport.orphan_dirs.length">{{ t('storageAuditExtra.orphanCount', { count: dirReport.orphan_dirs.length }) }}</b>
            <span v-if="dirReport.orphan_dirs.length && dirReport.misplaced_files.length">、</span>
            <b v-if="dirReport.misplaced_files.length">{{ t('storageAuditExtra.misplacedCount', { count: dirReport.misplaced_files.length }) }}</b>。
          </span>
        </div>

        <div class="fd-cards">
          <div class="fd-card">
            <div class="fc-label">{{ t('storageAuditExtra.scannedFolders') }}</div>
            <div class="fc-value">{{ dirReport.scanned_folders }}</div>
          </div>
          <div class="fd-card" :class="{ warnMiss: dirReport.missing_dirs.length }">
            <div class="fc-label">{{ t('storageAuditUi.missingDirs') }}</div>
            <div class="fc-value">{{ dirReport.missing_dirs.length }}</div>
            <div class="fc-hint">{{ t('storageAuditExtra.missingHint') }}</div>
          </div>
          <div class="fd-card" :class="{ warnOrphan: dirReport.orphan_dirs.length }">
            <div class="fc-label">{{ t('storageAuditUi.orphanDirs') }}</div>
            <div class="fc-value">{{ dirReport.orphan_dirs.length }}</div>
            <div class="fc-hint">{{ t('storageAuditExtra.orphanHint') }}</div>
          </div>
          <div class="fd-card" :class="{ warnOrphan: dirReport.misplaced_files.length }">
            <div class="fc-label">{{ t('storageAuditUi.misplacedFiles') }}</div>
            <div class="fc-value">{{ dirReport.misplaced_files.length }}</div>
            <div class="fc-hint">{{ t('storageAuditExtra.misplacedCardHint') }}</div>
          </div>
        </div>

        <div v-if="dirLastFix" class="fd-fix-result">
          <Icon name="status.check-circle" size="sm" />
          {{ t('storageAuditExtra.lastFix', { created: dirLastFix.created, removed: dirLastFix.removed, relocated: dirLastFix.relocated }) }}
        </div>

        <div v-if="dirReport.missing_dirs.length" class="fd-section">
          <div class="sec-title miss">{{ t('storageAuditExtra.missingSection') }}</div>
          <ul class="dir-list">
            <li v-for="d in dirReport.missing_dirs" :key="d" class="dir-item">{{ d }}</li>
          </ul>
        </div>

        <div v-if="dirReport.orphan_dirs.length" class="fd-section">
          <div class="sec-title orphan">{{ t('storageAuditExtra.orphanSection') }}</div>
          <ul class="dir-list">
            <li v-for="d in dirReport.orphan_dirs" :key="d" class="dir-item">{{ d }}</li>
          </ul>
          <Checkbox v-model="removeOrphans" class="fd-confirm">
            {{ t('storageAuditUi.confirmOrphans') }}
          </Checkbox>
        </div>

        <div v-if="dirReport.misplaced_files.length" class="fd-section">
          <div class="sec-title orphan">{{ t('storageAuditExtra.misplacedSection') }}</div>
          <ul class="dir-list">
            <li v-for="m in dirReport.misplaced_files" :key="m.file_id" class="dir-item misplaced-item">
              <div class="misplaced-name">{{ m.display_name }}（#{{ m.file_id }}）</div>
              <div class="misplaced-path"><span class="from">{{ m.current_key }}</span> → <span class="to">{{ m.expected_key }}</span></div>
            </li>
          </ul>
          <Checkbox v-model="relocateFiles" class="fd-confirm">
            {{ t('storageAuditExtra.relocateConfirm') }}
          </Checkbox>
        </div>

        <div v-if="!dirReport.healthy" class="fd-actions">
          <ActionButton :disabled="dirFixing" fit @click="repairDirs()">
            <Icon name="admin.wrench" size="sm" />
            {{ dirFixBtnLabel }}
          </ActionButton>
          <span class="fd-actions-note">{{ t('storageAuditExtra.actionsNote') }}</span>
        </div>
      </template>
    </section>

    <!-- ══ 记忆旧文件清理：迁移遗留的旧格式文件（summary.md/.ts、facts.md/.json 等） ══ -->
    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">{{ t('storageAuditUi.memoryTitle') }}</h3>
          <p class="sa-card-sub">{{ t('storageAuditUi.memoryHint') }}</p>
        </div>
        <ActionButton variant="secondary" fit :disabled="memScanning" @click="scanLegacyMemory">
          <Icon name="action.search" size="sm" />
          {{ memScanning ? t('storageAuditExtra.scanning') : t('storageAuditExtra.scan') }}
        </ActionButton>
      </div>

      <div v-if="memMsg" class="sa-inline-msg" :class="memMsgKind">{{ memMsg }}</div>

      <template v-if="memReport">
        <div v-if="!memReport.files.length" class="recon-ok"><RiCheckFill class="recon-ok__icon" aria-hidden="true" />{{ t('storageAuditExtra.noLegacy') }}</div>
        <template v-else>
          <div class="recon-summary">
            {{ t('storageAuditExtra.legacySummary', { total: memReport.files.length, safe: memReport.safeCount }) }}
          </div>
          <div class="recon-block">
            <div class="recon-block-title">
              {{ t('storageAuditExtra.legacyList') }}
              <span class="recon-bulk">
                <ActionButton class="recon-act recon-act-del" variant="secondary" fit :disabled="memCleaning || !memReport.safeCount"
                        @click="cleanupLegacy(memReport.files.filter(f => f.safeToDelete).map(f => f.key))">
                  <Icon name="action.delete" size="sm" />{{ t('storageAuditExtra.cleanupSafe', { count: memReport.safeCount }) }}
                </ActionButton>
              </span>
            </div>
            <div v-for="f in memReport.files" :key="f.key" class="recon-row">
              <span class="recon-name">{{ f.legacyFile }}</span>
              <span class="recon-meta">
                {{ f.key }} · {{ t('storageAuditExtra.replacedBy', { name: f.replacedBy }) }}
                <template v-if="!f.safeToDelete"> · <span class="status-warning-text">{{ t('storageAuditExtra.unsafe') }}</span></template>
              </span>
              <span class="recon-row-acts">
                <ActionButton class="recon-act recon-act-del" variant="secondary" fit :disabled="memCleaning || !f.safeToDelete"
                        @click="cleanupLegacy([f.key])" :title="t('storageAuditExtra.deleteLegacy')"><Icon name="action.delete" size="sm" />{{ t('storageAuditExtra.delete') }}</ActionButton>
              </span>
            </div>
          </div>
        </template>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { RiCheckFill } from '@remixicon/vue'
import FileSyncAdminPanel from '@/components/filesync/FileSyncAdminPanel.vue'

const adminStore = useAdminStore()
const { t } = useI18n()

interface TrashMigrationReport { backend: string; count: number; items: Array<{ file_id: number; name: string; source_key: string; target_key: string }>; note?: string }
const trashMigrating = ref(false)
const trashMigration = ref<TrashMigrationReport | null>(null)
const trashMigrationMsg = ref('')
const trashMigrationKind = ref<'ok' | 'err'>('ok')

async function scanTrashMigration() {
  trashMigrating.value = true
  trashMigrationMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/migrate-trash')
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.scanFailed', { message: '' }))
    trashMigration.value = data
  } catch (e) {
    trashMigrationKind.value = 'err'
    trashMigrationMsg.value = e instanceof Error ? e.message : String(e)
  } finally { trashMigrating.value = false }
}

async function runTrashMigration() {
  const ids = trashMigration.value?.items.map(item => item.file_id) || []
  if (!ids.length || !await confirmDialog({ title: t('storageAuditExtra.migrationTitle'), message: t('storageAuditExtra.migrationConfirm', { count: ids.length }), tone: 'warning', confirmText: t('storageAuditExtra.migrationStart') })) return
  trashMigrating.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/migrate-trash', {
      method: 'POST', body: JSON.stringify({ file_ids: ids }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.migrationFailed', { message: '' }))
    trashMigrationKind.value = data.skipped?.length ? 'err' : 'ok'
    trashMigrationMsg.value = t('storageAuditExtra.migrated', { count: data.done.length }) + (data.skipped?.length ? t('storageAuditExtra.skipped', { count: data.skipped.length }) : '')
    await scanTrashMigration()
  } catch (e) {
    trashMigrationKind.value = 'err'
    trashMigrationMsg.value = e instanceof Error ? e.message : String(e)
  } finally { trashMigrating.value = false }
}

// ── 文件对账（存储对象 ↔ File 记录）──────────────────────────────────────────
const fileScanning = ref(false)
const fileRepairing = ref(false)
const fileReport = ref<any | null>(null)
const fileMsg = ref('')
const fileMsgKind = ref<'ok' | 'err'>('ok')

interface UserStorageItem {
  user_id: string
  username: string
  display_name: string | null
  account_status: string
  created_at: string | null
  files: number
  projects: number
  scheduled_tasks: number
  physical_files: number
  reason: 'missing_directory' | 'missing_files'
}
interface UserStorageReport { backend: string; location: string; user_count: number; missing_directory_count: number; missing_file_user_count: number; users: UserStorageItem[] }
const userScanning = ref(false)
const userCleaning = ref(false)
const userReport = ref<UserStorageReport | null>(null)
const userMsg = ref('')
const userMsgKind = ref<'ok' | 'err'>('ok')

async function scanUsers() {
  userScanning.value = true
  userMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-users')
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditUi.userScanFailed'))
    userReport.value = data
  } catch (e) {
    userMsgKind.value = 'err'
    userMsg.value = e instanceof Error ? e.message : String(e)
  } finally { userScanning.value = false }
}

async function cleanUsers() {
  const users = userReport.value?.users || []
  if (!users.length || !await confirmDialog({
    title: t('storageAuditUi.userCleanTitle'),
    message: t('storageAuditUi.userCleanConfirm', { count: users.length }),
    tone: 'danger',
    confirmText: t('storageAuditUi.userCleanConfirmButton'),
  })) return
  userCleaning.value = true
  userMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-users/repair', {
      method: 'POST',
      body: JSON.stringify({ user_ids: users.map(user => user.user_id), confirm: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditUi.userCleanFailed'))
    userMsgKind.value = data.skipped?.length ? 'err' : 'ok'
    userMsg.value = t('storageAuditUi.userCleanResult', { done: data.done.length, skipped: data.skipped?.length || 0 })
    await scanUsers()
    await scanFiles()
  } catch (e) {
    userMsgKind.value = 'err'
    userMsg.value = e instanceof Error ? e.message : String(e)
  } finally { userCleaning.value = false }
}

const pathScanning = ref(false)
const pathRepairing = ref(false)
const pathReport = ref<any | null>(null)
const pathMsg = ref('')
const pathMsgKind = ref<'ok' | 'err'>('ok')

async function scanPathMigration() {
  pathScanning.value = true
  pathMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/path-migration')
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.pathScanFailed', { message: '' }))
    pathReport.value = data
  } catch (e) {
    pathMsgKind.value = 'err'
    pathMsg.value = e instanceof Error ? e.message : String(e)
  } finally { pathScanning.value = false }
}

async function repairPathMigration() {
  const items = pathReport.value?.candidates || []
  if (!items.length || !await confirmDialog({ title: t('storageAuditExtra.pathRepairTitle'), message: t('storageAuditExtra.pathRepairConfirm', { count: items.length }), tone: 'warning', confirmText: t('storageAuditExtra.pathRepairStart') })) return
  pathRepairing.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/path-migration/repair', {
      method: 'POST', body: JSON.stringify({ items: items.map((item: any) => ({
        file_id: item.file_id,
        key: item.key,
        expected_old_key: item.expected_old_key,
      })) }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.pathRepairFailed', { message: '' }))
    pathMsgKind.value = data.failed?.length ? 'err' : 'ok'
    pathMsg.value = t('storageAuditExtra.pathRepaired', { count: data.done.length }) + (data.failed?.length ? ` ${t('storageAuditExtra.failed', { count: data.failed.length })}` : '')
    await scanPathMigration()
  } catch (e) {
    pathMsgKind.value = 'err'
    pathMsg.value = e instanceof Error ? e.message : String(e)
  } finally { pathRepairing.value = false }
}

async function scanFiles() {
  if (fileScanning.value) return
  fileScanning.value = true
  fileMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage')
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.auditFailed', { message: '' }))
    fileReport.value = data
  } catch (e) {
    fileReport.value = { error: e instanceof Error ? e.message : String(e) }
  } finally {
    fileScanning.value = false
  }
}

async function repairOrphans(keys: string[], action: 'import' | 'delete') {
  if (fileRepairing.value || !keys.length) return
  if (action === 'delete' && !await confirmDialog({ title: t('storageAuditExtra.orphanDeleteTitle'), message: t('storageAuditExtra.orphanDeleteConfirm', { count: keys.length }), tone: 'danger', confirmText: t('storageAuditExtra.permanentDelete') })) return
  fileRepairing.value = true
  fileMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/repair', {
      method: 'POST',
      body: JSON.stringify({ action, keys, confirm: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.repairFailure', { message: '' }))
    const doneSet = new Set<string>(data.done_keys || [])
    if (fileReport.value?.orphans) {
      fileReport.value.orphans = fileReport.value.orphans.filter((k: string) => !doneSet.has(k))
      fileReport.value.orphan_count = fileReport.value.orphans.length
    }
    if (data.failed?.length) {
      fileMsgKind.value = 'err'
      fileMsg.value = t('storageAuditExtra.repairResult', { done: data.done, failed: data.failed.length }) + `: ` + data.failed.map((f: any) => `${f.key}: ${f.error}`).join('；')
    } else {
      fileMsgKind.value = 'ok'
      fileMsg.value = t('storageAuditExtra.repaired', { count: data.done, action: action === 'import' ? t('storageAuditExtra.actionImport') : t('storageAuditExtra.actionDelete') })
    }
  } catch (e) {
    fileMsgKind.value = 'err'
    fileMsg.value = t('storageAuditExtra.repairFailure', { message: e instanceof Error ? e.message : String(e) })
  } finally {
    fileRepairing.value = false
  }
}

async function repairMisplaced() {
  if (fileRepairing.value || !fileReport.value?.misplaced_count) return
  if (!await confirmDialog({ title: t('storageAuditExtra.relocateTitle'), message: t('storageAuditExtra.relocateConfirmTitle', { count: fileReport.value.misplaced_count }), tone: 'warning', confirmText: t('storageAuditExtra.relocateFiles') })) return
  fileRepairing.value = true
  fileMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/folder-doctor/repair', {
      method: 'POST',
      body: JSON.stringify({ relocate_files: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.pathRepairFailed', { message: '' }))
    fileMsgKind.value = 'ok'
    fileMsg.value = t('storageAuditExtra.relocated', { count: data.relocated || 0 })
    await scanFiles()
  } catch (e) {
    fileMsgKind.value = 'err'
    fileMsg.value = e instanceof Error ? e.message : String(e)
  } finally { fileRepairing.value = false }
}

// ── 目录对账（文件夹树 ↔ 磁盘目录 + 文件物理位置）────────────────────────────
interface MisplacedFile {
  file_id: number
  display_name: string
  current_key: string
  expected_key: string
}
interface DoctorReport {
  missing_dirs: string[]
  orphan_dirs: string[]
  misplaced_files: MisplacedFile[]
  scanned_folders: number
  created: number
  removed: number
  relocated: number
  healthy: boolean
}

const userId = ref('')
const dirReport = ref<DoctorReport | null>(null)
const dirLastFix = ref<{ created: number; removed: number; relocated: number } | null>(null)
const removeOrphans = ref(false)
const relocateFiles = ref(false)
const dirScanning = ref(false)
const dirFixing = ref(false)
const dirErr = ref('')

const dirFixBtnLabel = computed(() => {
  const parts: string[] = []
  if (dirReport.value?.missing_dirs.length) parts.push(t('storageAuditExtra.actionMissing'))
  if (removeOrphans.value && dirReport.value?.orphan_dirs.length) parts.push(t('storageAuditExtra.actionOrphan'))
  if (relocateFiles.value && dirReport.value?.misplaced_files.length) parts.push(t('storageAuditExtra.actionRelocate'))
  return parts.length ? t('storageAuditExtra.actionWithParts', { parts: parts.join(' + ') }) : t('storageAuditExtra.noAction')
})

function dirQs(): string {
  return userId.value ? `?user_id=${encodeURIComponent(userId.value)}` : ''
}

async function scanDirs() {
  dirScanning.value = true
  dirErr.value = ''
  dirLastFix.value = null
  removeOrphans.value = false
  relocateFiles.value = false
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/folder-doctor/scan${dirQs()}`)
    if (!res.ok) throw new Error(t('storageAuditExtra.scanFailed', { message: `(${res.status})` }))
    dirReport.value = await res.json()
  } catch (e: any) {
    dirErr.value = e.message
    dirReport.value = null
  } finally {
    dirScanning.value = false
  }
}

async function repairDirs() {
  dirFixing.value = true
  dirErr.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/folder-doctor/repair', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId.value || null,
        remove_orphans: removeOrphans.value,
        relocate_files: relocateFiles.value,
      }),
    })
    if (!res.ok) throw new Error(t('storageAuditExtra.repairFailure', { message: `(${res.status})` }))
    const fresh: DoctorReport = await res.json()
    dirLastFix.value = { created: fresh.created, removed: fresh.removed, relocated: fresh.relocated }
    dirReport.value = fresh
    removeOrphans.value = false
    relocateFiles.value = false
  } catch (e: any) {
    dirErr.value = e.message
  } finally {
    dirFixing.value = false
  }
}

// ── 记忆旧文件清理 ────────────────────────────────────────────────────────
interface LegacyMemoryFile {
  key: string
  legacyFile: string
  replacedBy: string
  safeToDelete: boolean
  size: number | null
}
interface LegacyMemoryReport {
  files: LegacyMemoryFile[]
  safeCount: number
}

const memScanning = ref(false)
const memCleaning = ref(false)
const memReport = ref<LegacyMemoryReport | null>(null)
const memMsg = ref('')
const memMsgKind = ref<'ok' | 'err'>('ok')

async function scanLegacyMemory() {
  if (memScanning.value) return
  memScanning.value = true
  memMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/memory/legacy-files')
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.scanFailed', { message: '' }))
    memReport.value = data
  } catch (e) {
    memMsgKind.value = 'err'
    memMsg.value = t('storageAuditExtra.scanFailed', { message: e instanceof Error ? e.message : String(e) })
    memReport.value = null
  } finally {
    memScanning.value = false
  }
}

async function cleanupLegacy(keys: string[]) {
  if (memCleaning.value || !keys.length) return
  if (!await confirmDialog({ title: t('storageAuditExtra.cleanupTitle'), message: t('storageAuditExtra.cleanupConfirm', { count: keys.length }), tone: 'danger', confirmText: t('storageAuditExtra.permanentDelete') })) return
  memCleaning.value = true
  memMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/memory/legacy-files/cleanup', {
      method: 'POST',
      body: JSON.stringify({ keys }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || t('storageAuditExtra.cleanupFailed', { message: '' }))
    const doneSet = new Set<string>(data.deleted || [])
    if (memReport.value) {
      memReport.value.files = memReport.value.files.filter(f => !doneSet.has(f.key))
      memReport.value.safeCount = memReport.value.files.filter(f => f.safeToDelete).length
    }
    memMsgKind.value = data.skipped?.length ? 'err' : 'ok'
    memMsg.value = data.skipped?.length
      ? t('storageAuditExtra.deletedSkipped', { deleted: data.deleted.length, skipped: data.skipped.length })
      : t('storageAuditExtra.deletedLegacy', { count: data.deleted.length })
  } catch (e) {
    memMsgKind.value = 'err'
    memMsg.value = t('storageAuditExtra.cleanupFailed', { message: e instanceof Error ? e.message : String(e) })
  } finally {
    memCleaning.value = false
  }
}
</script>

<style scoped>
.sa-page { padding: 28px 32px; color: var(--content-primary); font-family: var(--font-sans); font-size: var(--font-size-body); line-height: var(--line-height-body); }
.sa-head { margin-bottom: 20px; }
.sa-title { font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); margin: 0; }
.sa-sub { font-size: var(--font-size-sm); color: var(--content-secondary); margin: 4px 0 0; max-width: 720px; }
.sa-sub b { color: var(--content-primary); font-weight: var(--font-weight-semibold); }

.sa-card {
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 16px; padding: 20px 22px; margin-bottom: 20px;
}
.sa-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.sa-card-head:last-child { margin-bottom: 0; }
.sa-card-title { font-size: var(--font-size-md); font-weight: var(--font-weight-bold); margin: 0; }
.sa-card-sub { font-size: var(--font-size-sm); color: var(--content-secondary); margin: 4px 0 0; max-width: 560px; }
.sa-card-head-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

.sa-input {
  width: 220px; font-size: var(--font-size-sm); padding: 7px 11px; border-radius: 9px;
  outline: none;
}

.sa-inline-msg { font-size: var(--font-size-sm); margin-bottom: 10px; padding: 8px 12px; border-radius: 8px; }
.sa-inline-msg.ok { color: var(--status-success); background: var(--status-success-bg); border: 1px solid color-mix(in srgb, var(--status-success) 22%, transparent); }
.sa-inline-msg.err { color: var(--status-danger); background: var(--status-danger-bg); border: 1px solid color-mix(in srgb, var(--status-danger) 25%, transparent); }

/* 文件对账报告（沿用 Config 对账样式） */
.recon-report { margin-top: 4px; padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); font-size: var(--font-size-sm); }
.recon-summary { line-height: var(--line-height-body); color: var(--content-primary); }
.recon-summary b { font-weight: var(--font-weight-bold); }
.recon-ok { display: flex; align-items: center; gap: 4px; margin-top: 8px; color: var(--status-success); font-weight: var(--font-weight-semibold); }
.recon-ok__icon { width: 1em; height: 1em; flex: 0 0 auto; }
.recon-err { color: var(--status-danger); font-weight: var(--font-weight-semibold); }
.recon-block { margin-top: 10px; }
.recon-block-title { font-weight: var(--font-weight-semibold); margin-bottom: 4px; color: var(--content-primary); }
.recon-row { padding: 4px 0; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: 8px; align-items: center; }
.recon-name { font-weight: var(--font-weight-semibold); color: var(--content-primary); }
.recon-meta { color: var(--content-secondary); word-break: break-all; flex: 1; min-width: 0; }
.recon-row-acts, .recon-bulk { display: inline-flex; gap: 6px; flex-shrink: 0; margin-left: 8px; }
.recon-act { font-size: var(--font-size-xs); }
.app-action-button.recon-act-del { border-color: color-mix(in srgb, var(--status-danger) 40%, transparent); color: var(--status-danger); }

/* 目录对账报告 */
.fd-banner { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-size: var(--font-size-sm); }
.fd-banner.ok { background: var(--status-success-bg); border: 1px solid color-mix(in srgb, var(--status-success) 25%, transparent); color: var(--status-success); }
.fd-banner.alert { background: var(--status-warning-bg); border: 1px solid color-mix(in srgb, var(--status-warning) 30%, transparent); color: var(--status-warning); }
.fd-banner b { font-weight: var(--font-weight-bold); }

.fd-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
.fd-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px 16px; }
.fd-card.warnMiss { border-color: rgba(120,150,210,0.4); background: rgba(120,150,210,0.08); }
.fd-card.warnOrphan { border-color: rgba(210,150,60,0.4); background: rgba(210,150,60,0.08); }
.fc-label { font-size: var(--font-size-sm); color: var(--content-secondary); margin-bottom: 8px; }
.fc-value { font-size: var(--font-size-xl); font-weight: var(--font-weight-bold); line-height: var(--line-height-tight); }
.fc-hint { font-size: var(--font-size-xs); color: var(--content-secondary); margin-top: 6px; }

.fd-fix-result { display: flex; align-items: center; gap: 8px; font-size: var(--font-size-sm); color: var(--status-success); margin-bottom: 16px;
  background: rgba(90,180,120,0.08); border: 1px solid rgba(90,180,120,0.2); border-radius: 10px; padding: 10px 14px; }
.fd-fix-result b { font-weight: var(--font-weight-bold); }

.fd-section { margin-bottom: 18px; }
.sec-title { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); margin-bottom: 10px; }
.sec-title.miss { color: var(--status-info); }
.sec-title.orphan { color: var(--status-warning); }
.dir-list { list-style: none; margin: 0; padding: 8px; max-height: 240px; overflow-y: auto;
  background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
.dir-item { font-family: var(--font-mono); font-size: var(--font-size-sm); color: var(--content-primary);
  padding: 4px 8px; border-radius: 6px; word-break: break-all; }
.dir-item:hover { background: rgba(255,255,255,0.04); }
.misplaced-item { padding: 6px 8px; }
.misplaced-name { font-family: var(--font-sans); font-weight: var(--font-weight-semibold); color: var(--content-primary); margin-bottom: 2px; }
.misplaced-path { font-size: var(--font-size-xs); }
.misplaced-path .from { color: var(--status-warning); }
.misplaced-path .to { color: var(--status-success); }

.fd-confirm { margin-top: 12px; font-size: var(--font-size-sm); color: var(--content-secondary); }

.fd-actions { display: flex; align-items: center; gap: 14px; margin-top: 4px; flex-wrap: wrap; }
.fd-actions-note { font-size: var(--font-size-sm); color: var(--content-secondary); }
.status-success-text { color: var(--status-success); }
.status-danger-text { color: var(--status-danger); }
.status-warning-text { color: var(--status-warning); }
</style>
