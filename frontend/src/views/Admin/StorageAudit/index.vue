<template>
  <div class="sa-page">
    <div class="sa-head">
      <h2 class="sa-title">存储对账</h2>
      <p class="sa-sub">存储 ↔ DB 一致性核查：<b>文件层</b>（存储对象 ↔ File 记录）与<b>目录层</b>（文件夹树 ↔ 磁盘目录）。扫描只读、不改数据；修复需显式操作。</p>
    </div>

    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">旧回收站目录迁移</h3>
          <p class="sa-card-sub">把旧版 trash/{file_id}/ 文件迁移到保留原目录的新结构；扫描只读，迁移不会覆盖目标文件。</p>
        </div>
        <div class="sa-card-head-right">
          <button class="sa-btn" :disabled="trashMigrating" @click="scanTrashMigration">扫描旧目录</button>
          <button v-if="trashMigration?.items?.length" class="sa-btn primary" :disabled="trashMigrating" @click="runTrashMigration">迁移 {{ trashMigration.items.length }} 项</button>
        </div>
      </div>
      <div v-if="trashMigrationMsg" class="sa-inline-msg" :class="trashMigrationKind">{{ trashMigrationMsg }}</div>
      <div v-if="trashMigration" class="recon-summary">
        <template v-if="trashMigration.note">{{ trashMigration.note }}</template>
        <template v-else>发现 <b>{{ trashMigration.count }}</b> 个旧目录对象</template>
      </div>
    </section>

    <!-- ══ 文件对账：存储对象 ↔ File 记录 ══ -->
    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">文件对账</h3>
          <p class="sa-card-sub">扫描物理对象与 File 表：幽灵记录（DB 有、文件丢）+ 孤儿文件（文件在、DB 无）</p>
        </div>
        <button class="sa-btn" :disabled="fileScanning" @click="scanFiles">
          <Icon name="action.search" size="sm" />
          {{ fileScanning ? '对账中…' : '扫描' }}
        </button>
      </div>

      <div v-if="fileMsg" class="sa-inline-msg" :class="fileMsgKind">{{ fileMsg }}</div>

      <div v-if="fileReport" class="recon-report">
        <div v-if="fileReport.error" class="recon-err">对账失败：{{ fileReport.error }}</div>
        <template v-else>
          <div class="recon-summary">
            存储 <b>{{ fileReport.backend }}</b>（{{ fileReport.location }}） ·
            DB 文件 <b>{{ fileReport.db_file_rows }}</b> · 存储对象 <b>{{ fileReport.storage_objects }}</b> ·
            对得上 <b style="color:#5ab899">{{ fileReport.matched }}</b> ·
            幽灵 <b :style="{ color: fileReport.ghost_count ? '#e07676' : 'inherit' }">{{ fileReport.ghost_count }}</b> ·
            孤儿 <b :style="{ color: fileReport.orphan_count ? '#e0a96a' : 'inherit' }">{{ fileReport.orphan_count }}</b> ·
            位置错位 <b :style="{ color: fileReport.misplaced_count ? '#e0a96a' : 'inherit' }">{{ fileReport.misplaced_count || 0 }}</b>
          </div>
          <div v-if="!fileReport.ghost_count && !fileReport.orphan_count && !fileReport.misplaced_count" class="recon-ok">
            ✅ DB 与存储一一对应，路径归属也正确。
          </div>
          <div v-if="fileReport.ghost_count" class="recon-block">
            <div class="recon-block-title">幽灵记录（DB 有行但物理文件缺失，点开会 404）</div>
            <div v-for="g in fileReport.ghosts" :key="g.id" class="recon-row">
              <span class="recon-name">{{ g.name }}</span>
              <span class="recon-meta">{{ g.space }}{{ g.project ? ' · ' + g.project : '' }}{{ g.deleted ? ' · 回收站' : '' }} · {{ g.storage_key }}</span>
            </div>
          </div>
          <div v-if="fileReport.orphan_count" class="recon-block">
            <div class="recon-block-title">
              孤儿文件（物理文件存在但 DB 无记录，app 里看不见）
              <span class="recon-bulk">
                <button class="recon-act" :disabled="fileRepairing" @click="repairOrphans(fileReport.orphans, 'import')">全部导入</button>
                <button class="recon-act recon-act-del" :disabled="fileRepairing" @click="repairOrphans(fileReport.orphans, 'delete')">全部删除</button>
              </span>
            </div>
            <div v-for="o in fileReport.orphans" :key="o" class="recon-row">
              <span class="recon-meta">{{ o }}</span>
              <span class="recon-row-acts">
                <button class="recon-act" :disabled="fileRepairing" @click="repairOrphans([o], 'import')" title="按路径重建 DB 记录，让它在 app 里现身">导入</button>
                <button class="recon-act recon-act-del" :disabled="fileRepairing" @click="repairOrphans([o], 'delete')" title="删除物理文件（不可恢复）">删除</button>
              </span>
            </div>
          </div>
          <div v-if="fileReport.misplaced_count" class="recon-block">
            <div class="recon-block-title">
              物理位置错位（文件所属目录与当前物理路径不一致）
              <span class="recon-bulk">
                <button class="recon-act" :disabled="fileRepairing" @click="repairMisplaced">全部搬回正确目录</button>
              </span>
            </div>
            <div v-for="item in fileReport.misplaced_files" :key="item.file_id" class="recon-row">
              <span class="recon-name">{{ item.display_name }}</span>
              <span class="recon-meta">{{ item.current_key }} → {{ item.expected_key }}</span>
            </div>
          </div>
          <div v-if="fileReport.truncated" class="recon-meta">（结果较多，列表仅显示前 300 条）</div>
        </template>
      </div>
    </section>

    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">路径归属修复</h3>
          <p class="sa-card-sub">匹配物理文件与旧 File 记录，更新 storage_key 和完整文件夹归属；只执行唯一匹配项。</p>
        </div>
        <div class="sa-card-head-right">
          <button class="sa-btn" :disabled="pathScanning" @click="scanPathMigration">扫描路径</button>
          <button v-if="pathReport?.candidates?.length" class="sa-btn primary" :disabled="pathRepairing" @click="repairPathMigration">
            修复 {{ pathReport.candidates.length }} 项
          </button>
        </div>
      </div>
      <div v-if="pathMsg" class="sa-inline-msg" :class="pathMsgKind">{{ pathMsg }}</div>
      <div v-if="pathReport" class="recon-report">
        <div class="recon-summary">可安全匹配 <b>{{ pathReport.candidate_count }}</b> 项 · 歧义 <b>{{ pathReport.ambiguous_count }}</b> 项</div>
        <div v-if="pathReport.ambiguous_count" class="recon-meta">存在同名同大小文件，已跳过，需要人工确认。</div>
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
          <h3 class="sa-card-title">目录对账</h3>
          <p class="sa-card-sub">diff 文件夹树期望目录 vs 磁盘目录：补缺失空目录（治 123）、清无主孤儿空目录（治 adr）</p>
        </div>
        <div class="sa-card-head-right">
          <input v-model.trim="userId" class="sa-input" placeholder="用户 ID（留空 = 全量）" @keyup.enter="scanDirs()" />
          <button class="sa-btn" :disabled="dirScanning" @click="scanDirs()">
            <Icon name="action.search" size="sm" />
            {{ dirScanning ? '对账中…' : '扫描' }}
          </button>
        </div>
      </div>

      <div v-if="dirErr" class="sa-inline-msg err">{{ dirErr }}</div>

      <template v-if="dirReport">
        <div class="fd-banner" :class="dirReport.healthy ? 'ok' : 'alert'">
          <Icon v-if="dirReport.healthy" name="status.check-circle" size="md" />
          <Icon v-else name="status.warning" size="md" />
          <span v-if="dirReport.healthy">目录一致，无缺失、无孤儿、无位置漂移。</span>
          <span v-else>
            发现
            <b v-if="dirReport.missing_dirs.length">{{ dirReport.missing_dirs.length }} 个缺失目录</b>
            <span v-if="dirReport.missing_dirs.length && (dirReport.orphan_dirs.length || dirReport.misplaced_files.length)">、</span>
            <b v-if="dirReport.orphan_dirs.length">{{ dirReport.orphan_dirs.length }} 个孤儿空目录</b>
            <span v-if="dirReport.orphan_dirs.length && dirReport.misplaced_files.length">、</span>
            <b v-if="dirReport.misplaced_files.length">{{ dirReport.misplaced_files.length }} 个位置不一致文件</b>。
          </span>
        </div>

        <div class="fd-cards">
          <div class="fd-card">
            <div class="fc-label">已对账文件夹</div>
            <div class="fc-value">{{ dirReport.scanned_folders }}</div>
          </div>
          <div class="fd-card" :class="{ warnMiss: dirReport.missing_dirs.length }">
            <div class="fc-label">缺失目录</div>
            <div class="fc-value">{{ dirReport.missing_dirs.length }}</div>
            <div class="fc-hint">DB 有夹、盘上没目录 · 可自动补</div>
          </div>
          <div class="fd-card" :class="{ warnOrphan: dirReport.orphan_dirs.length }">
            <div class="fc-label">孤儿空目录</div>
            <div class="fc-value">{{ dirReport.orphan_dirs.length }}</div>
            <div class="fc-hint">盘上有、无对应文件夹且为空 · 需确认清理</div>
          </div>
          <div class="fd-card" :class="{ warnOrphan: dirReport.misplaced_files.length }">
            <div class="fc-label">位置不一致文件</div>
            <div class="fc-value">{{ dirReport.misplaced_files.length }}</div>
            <div class="fc-hint">DB 归属已变、物理字节还在旧位置 · 需确认搬迁</div>
          </div>
        </div>

        <div v-if="dirLastFix" class="fd-fix-result">
          <Icon name="status.check-circle" size="sm" />
          上次修复：补齐 <b>{{ dirLastFix.created }}</b> 个缺失目录，清理 <b>{{ dirLastFix.removed }}</b> 个孤儿目录，
          搬迁 <b>{{ dirLastFix.relocated }}</b> 个位置不一致文件。
        </div>

        <div v-if="dirReport.missing_dirs.length" class="fd-section">
          <div class="sec-title miss">缺失目录（将被自动补齐 · mkdir，安全）</div>
          <ul class="dir-list">
            <li v-for="d in dirReport.missing_dirs" :key="d" class="dir-item">{{ d }}</li>
          </ul>
        </div>

        <div v-if="dirReport.orphan_dirs.length" class="fd-section">
          <div class="sec-title orphan">孤儿空目录（无对应文件夹的空骨架 · 清理不可恢复）</div>
          <ul class="dir-list">
            <li v-for="d in dirReport.orphan_dirs" :key="d" class="dir-item">{{ d }}</li>
          </ul>
          <Checkbox v-model="removeOrphans" class="fd-confirm">
            我确认清理上述孤儿空目录（仅删空目录，非空目录不受影响，且不可恢复）
          </Checkbox>
        </div>

        <div v-if="dirReport.misplaced_files.length" class="fd-section">
          <div class="sec-title orphan">位置不一致文件（DB 归属正常，物理字节还在旧位置 · 不含 mind 空间）</div>
          <ul class="dir-list">
            <li v-for="m in dirReport.misplaced_files" :key="m.file_id" class="dir-item misplaced-item">
              <div class="misplaced-name">{{ m.display_name }}（#{{ m.file_id }}）</div>
              <div class="misplaced-path"><span class="from">{{ m.current_key }}</span> → <span class="to">{{ m.expected_key }}</span></div>
            </li>
          </ul>
          <Checkbox v-model="relocateFiles" class="fd-confirm">
            我确认把上述文件搬到当前归属应在的位置（重命名冲突自动加后缀，不覆盖已有文件）
          </Checkbox>
        </div>

        <div v-if="!dirReport.healthy" class="fd-actions">
          <button class="sa-btn primary" :disabled="dirFixing" @click="repairDirs()">
            <Icon name="admin.wrench" size="sm" />
            {{ dirFixBtnLabel }}
          </button>
          <span class="fd-actions-note">修复在服务端重新扫描后执行——补缺失总是安全；孤儿/位置搬迁仅在勾选确认后才动。</span>
        </div>
      </template>
    </section>

    <!-- ══ 记忆旧文件清理：迁移遗留的旧格式文件（summary.md/.ts、facts.md/.json 等） ══ -->
    <section class="sa-card">
      <div class="sa-card-head">
        <div>
          <h3 class="sa-card-title">记忆旧文件清理</h3>
          <p class="sa-card-sub">咕咕记忆存储格式升级（如 summary.md+summary.ts → summary.json）不会自动删旧文件，只有新文件已确认写过才判定可清；避免误删还没迁移的原始数据。</p>
        </div>
        <button class="sa-btn" :disabled="memScanning" @click="scanLegacyMemory">
          <Icon name="action.search" size="sm" />
          {{ memScanning ? '扫描中…' : '扫描' }}
        </button>
      </div>

      <div v-if="memMsg" class="sa-inline-msg" :class="memMsgKind">{{ memMsg }}</div>

      <template v-if="memReport">
        <div v-if="!memReport.files.length" class="recon-ok">✅ 没有发现旧记忆文件。</div>
        <template v-else>
          <div class="recon-summary">
            共 <b>{{ memReport.files.length }}</b> 个旧文件，其中 <b style="color:#7fc99a">{{ memReport.safeCount }}</b> 个已确认迁移、可安全清理。
          </div>
          <div class="recon-block">
            <div class="recon-block-title">
              旧文件列表
              <span class="recon-bulk">
                <button class="recon-act recon-act-del" :disabled="memCleaning || !memReport.safeCount"
                        @click="cleanupLegacy(memReport.files.filter(f => f.safeToDelete).map(f => f.key))">
                  全部清理可安全项（{{ memReport.safeCount }}）
                </button>
              </span>
            </div>
            <div v-for="f in memReport.files" :key="f.key" class="recon-row">
              <span class="recon-name">{{ f.legacyFile }}</span>
              <span class="recon-meta">
                {{ f.key }} · 已被 {{ f.replacedBy }} 取代
                <template v-if="!f.safeToDelete"> · <span style="color:#d9a94e">新文件不存在，暂不判定可删</span></template>
              </span>
              <span class="recon-row-acts">
                <button class="recon-act recon-act-del" :disabled="memCleaning || !f.safeToDelete"
                        @click="cleanupLegacy([f.key])" title="删除这个旧文件（不可恢复）">删除</button>
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
import { confirmDialog } from '@/composables/useConfirmDialog'
import Checkbox from '@/components/common/Checkbox.vue'

const adminStore = useAdminStore()

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
    if (!res.ok) throw new Error(data.detail || '扫描失败')
    trashMigration.value = data
  } catch (e) {
    trashMigrationKind.value = 'err'
    trashMigrationMsg.value = e instanceof Error ? e.message : String(e)
  } finally { trashMigrating.value = false }
}

async function runTrashMigration() {
  const ids = trashMigration.value?.items.map(item => item.file_id) || []
  if (!ids.length || !await confirmDialog({ title: '迁移旧回收站文件', message: `确认迁移 ${ids.length} 个旧回收站文件？`, tone: 'warning', confirmText: '开始迁移' })) return
  trashMigrating.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/migrate-trash', {
      method: 'POST', body: JSON.stringify({ file_ids: ids }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '迁移失败')
    trashMigrationKind.value = data.skipped?.length ? 'err' : 'ok'
    trashMigrationMsg.value = `已迁移 ${data.done.length} 项${data.skipped?.length ? `，跳过 ${data.skipped.length} 项` : ''}`
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
    if (!res.ok) throw new Error(data.detail || '路径扫描失败')
    pathReport.value = data
  } catch (e) {
    pathMsgKind.value = 'err'
    pathMsg.value = e instanceof Error ? e.message : String(e)
  } finally { pathScanning.value = false }
}

async function repairPathMigration() {
  const items = pathReport.value?.candidates || []
  if (!items.length || !await confirmDialog({ title: '修复文件路径归属', message: `确认修复 ${items.length} 个文件的路径归属？`, tone: 'warning', confirmText: '开始修复' })) return
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
    if (!res.ok) throw new Error(data.detail || '路径修复失败')
    pathMsgKind.value = data.failed?.length ? 'err' : 'ok'
    pathMsg.value = `已修复 ${data.done.length} 项${data.failed?.length ? `，失败 ${data.failed.length} 项` : ''}`
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
    if (!res.ok) throw new Error(data.detail || '对账失败')
    fileReport.value = data
  } catch (e) {
    fileReport.value = { error: e instanceof Error ? e.message : String(e) }
  } finally {
    fileScanning.value = false
  }
}

async function repairOrphans(keys: string[], action: 'import' | 'delete') {
  if (fileRepairing.value || !keys.length) return
  if (action === 'delete' && !await confirmDialog({ title: '删除孤儿物理文件', message: `确认删除 ${keys.length} 个孤儿物理文件？此操作不可恢复。`, tone: 'danger', confirmText: '永久删除' })) return
  fileRepairing.value = true
  fileMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/repair', {
      method: 'POST',
      body: JSON.stringify({ action, keys }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '修复失败')
    const doneSet = new Set<string>(data.done_keys || [])
    if (fileReport.value?.orphans) {
      fileReport.value.orphans = fileReport.value.orphans.filter((k: string) => !doneSet.has(k))
      fileReport.value.orphan_count = fileReport.value.orphans.length
    }
    if (data.failed?.length) {
      fileMsgKind.value = 'err'
      fileMsg.value = `${data.done} 个成功，${data.failed.length} 个失败：` +
        data.failed.map((f: any) => `${f.key}: ${f.error}`).join('；')
    } else {
      fileMsgKind.value = 'ok'
      fileMsg.value = `已处理 ${data.done} 个孤儿文件（${action === 'import' ? '导入' : '删除'}）`
    }
  } catch (e) {
    fileMsgKind.value = 'err'
    fileMsg.value = `修复失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    fileRepairing.value = false
  }
}

async function repairMisplaced() {
  if (fileRepairing.value || !fileReport.value?.misplaced_count) return
  if (!await confirmDialog({ title: '修复文件物理位置', message: `确认搬回 ${fileReport.value.misplaced_count} 个文件的正确目录？`, tone: 'warning', confirmText: '搬回文件' })) return
  fileRepairing.value = true
  fileMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/folder-doctor/repair', {
      method: 'POST',
      body: JSON.stringify({ relocate_files: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '路径修复失败')
    fileMsgKind.value = 'ok'
    fileMsg.value = `已搬回 ${data.relocated || 0} 个文件`
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
  if (dirReport.value?.missing_dirs.length) parts.push('补齐缺失')
  if (removeOrphans.value && dirReport.value?.orphan_dirs.length) parts.push('清理孤儿')
  if (relocateFiles.value && dirReport.value?.misplaced_files.length) parts.push('搬迁文件')
  return parts.length ? `执行修复（${parts.join(' + ')}）` : '执行修复'
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
    if (!res.ok) throw new Error(`扫描失败 (${res.status})`)
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
    if (!res.ok) throw new Error(`修复失败 (${res.status})`)
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
    if (!res.ok) throw new Error(data.detail || '扫描失败')
    memReport.value = data
  } catch (e) {
    memMsgKind.value = 'err'
    memMsg.value = `扫描失败：${e instanceof Error ? e.message : String(e)}`
    memReport.value = null
  } finally {
    memScanning.value = false
  }
}

async function cleanupLegacy(keys: string[]) {
  if (memCleaning.value || !keys.length) return
  if (!await confirmDialog({ title: '删除旧记忆文件', message: `确认删除 ${keys.length} 个旧记忆文件？此操作不可恢复。`, tone: 'danger', confirmText: '永久删除' })) return
  memCleaning.value = true
  memMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/memory/legacy-files/cleanup', {
      method: 'POST',
      body: JSON.stringify({ keys }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '清理失败')
    const doneSet = new Set<string>(data.deleted || [])
    if (memReport.value) {
      memReport.value.files = memReport.value.files.filter(f => !doneSet.has(f.key))
      memReport.value.safeCount = memReport.value.files.filter(f => f.safeToDelete).length
    }
    memMsgKind.value = data.skipped?.length ? 'err' : 'ok'
    memMsg.value = data.skipped?.length
      ? `已删除 ${data.deleted.length} 个，跳过 ${data.skipped.length} 个（重新核实时发现不可安全删除）`
      : `已删除 ${data.deleted.length} 个旧记忆文件`
  } catch (e) {
    memMsgKind.value = 'err'
    memMsg.value = `清理失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    memCleaning.value = false
  }
}
</script>

<style scoped>
.sa-page { padding: 28px 32px; color: rgba(255,255,255,0.9); }
.sa-head { margin-bottom: 20px; }
.sa-title { font-size: 18px; font-weight: 700; margin: 0; }
.sa-sub { font-size: 12px; color: rgba(255,255,255,0.4); margin: 4px 0 0; max-width: 720px; }
.sa-sub b { color: rgba(255,255,255,0.6); font-weight: 600; }

.sa-card {
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 16px; padding: 20px 22px; margin-bottom: 20px;
}
.sa-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.sa-card-title { font-size: 15px; font-weight: 700; margin: 0; }
.sa-card-sub { font-size: 12px; color: rgba(255,255,255,0.4); margin: 4px 0 0; max-width: 560px; }
.sa-card-head-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

.sa-input {
  width: 220px; font-size: 13px; padding: 7px 11px; border-radius: 9px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.9); outline: none; transition: border-color 0.15s;
}
.sa-input::placeholder { color: rgba(255,255,255,0.28); }
.sa-input:focus { border-color: rgba(150,144,196,0.6); }

.sa-btn {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 9px;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.14);
  color: rgba(255,255,255,0.9); cursor: pointer; transition: all 0.15s;
}
.sa-btn:hover:not(:disabled) { background: rgba(255,255,255,0.16); }
.sa-btn:disabled { opacity: 0.5; cursor: default; }
.sa-btn.primary { background: var(--action-primary-bg); border-color: transparent; color: var(--content-on-accent); box-shadow: none; }
.sa-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }

.sa-inline-msg { font-size: 12px; margin-bottom: 10px; padding: 8px 12px; border-radius: 8px; }
.sa-inline-msg.ok { color: #7fc99a; background: rgba(90,180,120,0.1); border: 1px solid rgba(90,180,120,0.22); }
.sa-inline-msg.err { color: #e08a8a; background: rgba(210,80,80,0.1); border: 1px solid rgba(210,80,80,0.25); }

/* 文件对账报告（沿用 Config 对账样式） */
.recon-report { margin-top: 4px; padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); font-size: 12px; }
.recon-summary { line-height: 1.7; color: rgba(255,255,255,0.88); }
.recon-summary b { font-weight: 700; }
.recon-ok { margin-top: 8px; color: #5ab899; font-weight: 600; }
.recon-err { color: #e07676; font-weight: 600; }
.recon-block { margin-top: 10px; }
.recon-block-title { font-weight: 600; margin-bottom: 4px; color: rgba(255,255,255,0.85); }
.recon-row { padding: 4px 0; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: 8px; align-items: center; }
.recon-name { font-weight: 600; color: rgba(255,255,255,0.88); }
.recon-meta { color: rgba(255,255,255,0.45); word-break: break-all; flex: 1; min-width: 0; }
.recon-row-acts, .recon-bulk { display: inline-flex; gap: 6px; flex-shrink: 0; margin-left: 8px; }
.recon-act { padding: 2px 8px; border-radius: 6px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.78); }
.recon-act:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #fff; }
.recon-act:disabled { opacity: 0.5; cursor: default; }
.recon-act-del { border-color: rgba(224,118,118,0.4); color: #e08a8a; }
.recon-act-del:hover:not(:disabled) { background: rgba(224,118,118,0.18); color: #fff; }

/* 目录对账报告 */
.fd-banner { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-size: 13px; }
.fd-banner.ok { background: rgba(90,180,120,0.1); border: 1px solid rgba(90,180,120,0.25); color: #7fc99a; }
.fd-banner.alert { background: rgba(210,150,60,0.1); border: 1px solid rgba(210,150,60,0.3); color: #d9a94e; }
.fd-banner b { font-weight: 700; }

.fd-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
.fd-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px 16px; }
.fd-card.warnMiss { border-color: rgba(120,150,210,0.4); background: rgba(120,150,210,0.08); }
.fd-card.warnOrphan { border-color: rgba(210,150,60,0.4); background: rgba(210,150,60,0.08); }
.fc-label { font-size: 12px; color: rgba(255,255,255,0.45); margin-bottom: 8px; }
.fc-value { font-size: 24px; font-weight: 700; line-height: 1; }
.fc-hint { font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.fd-fix-result { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #7fc99a; margin-bottom: 16px;
  background: rgba(90,180,120,0.08); border: 1px solid rgba(90,180,120,0.2); border-radius: 10px; padding: 10px 14px; }
.fd-fix-result b { font-weight: 700; }

.fd-section { margin-bottom: 18px; }
.sec-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.sec-title.miss { color: #9db4e6; }
.sec-title.orphan { color: #d9a94e; }
.dir-list { list-style: none; margin: 0; padding: 8px; max-height: 240px; overflow-y: auto;
  background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
.dir-item { font-family: var(--font-mono, monospace); font-size: 12px; color: rgba(255,255,255,0.75);
  padding: 4px 8px; border-radius: 6px; word-break: break-all; }
.dir-item:hover { background: rgba(255,255,255,0.04); }
.misplaced-item { padding: 6px 8px; }
.misplaced-name { font-family: var(--font-sans, inherit); font-weight: 600; color: rgba(255,255,255,0.85); margin-bottom: 2px; }
.misplaced-path { font-size: 11px; }
.misplaced-path .from { color: #e0a96a; }
.misplaced-path .to { color: #7fc99a; }

.fd-confirm { margin-top: 12px; font-size: 13px; color: rgba(255,255,255,0.6); }

.fd-actions { display: flex; align-items: center; gap: 14px; margin-top: 4px; flex-wrap: wrap; }
.fd-actions-note { font-size: 12px; color: rgba(255,255,255,0.35); }
</style>
