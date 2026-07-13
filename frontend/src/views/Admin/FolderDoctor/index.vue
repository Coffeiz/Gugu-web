<template>
  <div class="fd-page">
    <div class="fd-head">
      <div>
        <h2 class="fd-title">目录对账</h2>
        <p class="fd-sub">diff「DB 文件夹树期望的目录」vs「磁盘实际目录」：补缺失空目录（治 123）、清无主孤儿空目录（治 adr）</p>
      </div>
      <div class="fd-head-right">
        <input
          v-model.trim="userId"
          class="fd-input"
          placeholder="用户 ID（留空 = 全量对账）"
          @keyup.enter="scan()"
        />
        <button class="fd-btn" :disabled="loading" @click="scan()">
          <PhMagnifyingGlass :size="15" weight="bold" />
          扫描
        </button>
      </div>
    </div>

    <div v-if="err" class="fd-err">{{ err }}</div>

    <!-- 未扫描态 -->
    <div v-if="!report && !loading" class="fd-hint-box">
      点「扫描」开始对账。扫描只读、不改盘；发现问题后再决定是否修复。
    </div>
    <div v-else-if="loading && !report" class="fd-hint-box">对账中…</div>

    <template v-if="report">
      <!-- 概览 -->
      <div
        class="fd-banner"
        :class="report.healthy ? 'ok' : 'alert'"
      >
        <PhCheckCircle v-if="report.healthy" :size="18" weight="fill" />
        <PhWarningCircle v-else :size="18" weight="fill" />
        <span v-if="report.healthy">目录一致，无缺失、无孤儿。</span>
        <span v-else>
          发现
          <b v-if="report.missing_dirs.length">{{ report.missing_dirs.length }} 个缺失目录</b>
          <span v-if="report.missing_dirs.length && report.orphan_dirs.length">、</span>
          <b v-if="report.orphan_dirs.length">{{ report.orphan_dirs.length }} 个孤儿空目录</b>
          。
        </span>
      </div>

      <div class="fd-cards">
        <div class="fd-card">
          <div class="fc-label">已对账文件夹</div>
          <div class="fc-value">{{ report.scanned_folders }}</div>
        </div>
        <div class="fd-card" :class="{ warnMiss: report.missing_dirs.length }">
          <div class="fc-label">缺失目录</div>
          <div class="fc-value">{{ report.missing_dirs.length }}</div>
          <div class="fc-hint">DB 有夹、盘上没目录 · 可自动补</div>
        </div>
        <div class="fd-card" :class="{ warnOrphan: report.orphan_dirs.length }">
          <div class="fc-label">孤儿空目录</div>
          <div class="fc-value">{{ report.orphan_dirs.length }}</div>
          <div class="fc-hint">盘上有、无对应文件夹且为空 · 需确认清理</div>
        </div>
      </div>

      <!-- 上一次修复结果 -->
      <div v-if="lastFix" class="fd-fix-result">
        <PhCheckCircle :size="15" weight="fill" />
        上次修复：补齐 <b>{{ lastFix.created }}</b> 个缺失目录，清理 <b>{{ lastFix.removed }}</b> 个孤儿目录。
      </div>

      <!-- 缺失目录 -->
      <div v-if="report.missing_dirs.length" class="fd-section">
        <div class="sec-title miss">缺失目录（将被自动补齐 · mkdir，安全）</div>
        <ul class="dir-list">
          <li v-for="d in report.missing_dirs" :key="d" class="dir-item">{{ d }}</li>
        </ul>
      </div>

      <!-- 孤儿目录 -->
      <div v-if="report.orphan_dirs.length" class="fd-section">
        <div class="sec-title orphan">孤儿空目录（无对应文件夹的空骨架 · 清理不可恢复）</div>
        <ul class="dir-list">
          <li v-for="d in report.orphan_dirs" :key="d" class="dir-item">{{ d }}</li>
        </ul>
        <label class="fd-confirm">
          <input type="checkbox" v-model="removeOrphans" />
          我确认清理上述孤儿空目录（仅删空目录，非空目录不受影响，且不可恢复）
        </label>
      </div>

      <!-- 修复操作 -->
      <div v-if="!report.healthy" class="fd-actions">
        <button class="fd-btn primary" :disabled="fixing" @click="repair()">
          <PhWrench :size="15" weight="bold" />
          {{ fixBtnLabel }}
        </button>
        <span class="fd-actions-note">
          修复会在服务端重新扫描后执行——补缺失总是安全；孤儿仅在勾选确认后才清。
        </span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { PhMagnifyingGlass, PhCheckCircle, PhWarningCircle, PhWrench } from '@phosphor-icons/vue'
import { useAdminStore } from '@/stores/admin'

interface DoctorReport {
  missing_dirs: string[]
  orphan_dirs: string[]
  scanned_folders: number
  created: number
  removed: number
  healthy: boolean
}

const adminStore = useAdminStore()
const userId = ref('')
const report = ref<DoctorReport | null>(null)
const lastFix = ref<{ created: number; removed: number } | null>(null)
const removeOrphans = ref(false)
const loading = ref(false)
const fixing = ref(false)
const err = ref('')

const fixBtnLabel = computed(() => {
  const parts: string[] = []
  if (report.value?.missing_dirs.length) parts.push('补齐缺失')
  if (removeOrphans.value && report.value?.orphan_dirs.length) parts.push('清理孤儿')
  return parts.length ? `执行修复（${parts.join(' + ')}）` : '执行修复'
})

function qs(): string {
  return userId.value ? `?user_id=${encodeURIComponent(userId.value)}` : ''
}

async function scan() {
  loading.value = true
  err.value = ''
  lastFix.value = null
  removeOrphans.value = false
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/folder-doctor/scan${qs()}`)
    if (!res.ok) throw new Error(`扫描失败 (${res.status})`)
    report.value = await res.json()
  } catch (e: any) {
    err.value = e.message
    report.value = null
  } finally {
    loading.value = false
  }
}

async function repair() {
  fixing.value = true
  err.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/folder-doctor/repair', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId.value || null,
        remove_orphans: removeOrphans.value,
      }),
    })
    if (!res.ok) throw new Error(`修复失败 (${res.status})`)
    const fresh: DoctorReport = await res.json()
    lastFix.value = { created: fresh.created, removed: fresh.removed }
    report.value = fresh          // repair 返回执行后的新报告
    removeOrphans.value = false
  } catch (e: any) {
    err.value = e.message
  } finally {
    fixing.value = false
  }
}
</script>

<style scoped>
.fd-page { padding: 28px 32px; color: rgba(255,255,255,0.9); }
.fd-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; gap: 16px; }
.fd-title { font-size: 18px; font-weight: 700; margin: 0; }
.fd-sub { font-size: 12px; color: rgba(255,255,255,0.4); margin: 4px 0 0; max-width: 640px; }
.fd-head-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

.fd-input {
  width: 240px; font-size: 13px; padding: 7px 11px; border-radius: 9px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.9); outline: none; transition: border-color 0.15s;
}
.fd-input::placeholder { color: rgba(255,255,255,0.28); }
.fd-input:focus { border-color: rgba(150,144,196,0.6); }

.fd-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 9px;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.14);
  color: rgba(255,255,255,0.9); cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.fd-btn:hover:not(:disabled) { background: rgba(255,255,255,0.16); }
.fd-btn:disabled { opacity: 0.5; cursor: default; }
.fd-btn.primary {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border-color: transparent; color: #fff;
}
.fd-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }

.fd-err { color: #e08a8a; font-size: 13px; margin-bottom: 12px; }
.fd-hint-box {
  font-size: 13px; color: rgba(255,255,255,0.4);
  background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.1);
  border-radius: 12px; padding: 20px 18px; text-align: center;
}

/* 概览横幅 */
.fd-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-radius: 12px; margin-bottom: 18px; font-size: 13px;
}
.fd-banner.ok { background: rgba(90,180,120,0.1); border: 1px solid rgba(90,180,120,0.25); color: #7fc99a; }
.fd-banner.alert { background: rgba(210,150,60,0.1); border: 1px solid rgba(210,150,60,0.3); color: #d9a94e; }
.fd-banner b { font-weight: 700; }

/* 概览卡片 */
.fd-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
.fd-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; padding: 16px 18px;
}
.fd-card.warnMiss { border-color: rgba(120,150,210,0.4); background: rgba(120,150,210,0.08); }
.fd-card.warnOrphan { border-color: rgba(210,150,60,0.4); background: rgba(210,150,60,0.08); }
.fc-label { font-size: 12px; color: rgba(255,255,255,0.45); margin-bottom: 8px; }
.fc-value { font-size: 26px; font-weight: 700; line-height: 1; }
.fc-hint { font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.fd-fix-result {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; color: #7fc99a; margin-bottom: 18px;
  background: rgba(90,180,120,0.08); border: 1px solid rgba(90,180,120,0.2);
  border-radius: 10px; padding: 10px 14px;
}
.fd-fix-result b { font-weight: 700; }

/* section */
.fd-section { margin-bottom: 22px; }
.sec-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.sec-title.miss { color: #9db4e6; }
.sec-title.orphan { color: #d9a94e; }
.dir-list {
  list-style: none; margin: 0; padding: 8px; max-height: 260px; overflow-y: auto;
  background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px;
}
.dir-item {
  font-family: var(--font-mono, monospace); font-size: 12px;
  color: rgba(255,255,255,0.75); padding: 4px 8px; border-radius: 6px;
  word-break: break-all;
}
.dir-item:hover { background: rgba(255,255,255,0.04); }

.fd-confirm {
  display: flex; align-items: center; gap: 8px; margin-top: 12px;
  font-size: 13px; color: rgba(255,255,255,0.6); cursor: pointer; user-select: none;
}
.fd-confirm input { accent-color: #d9a94e; width: 15px; height: 15px; cursor: pointer; }

.fd-actions { display: flex; align-items: center; gap: 14px; margin-top: 8px; flex-wrap: wrap; }
.fd-actions-note { font-size: 12px; color: rgba(255,255,255,0.35); }
</style>
