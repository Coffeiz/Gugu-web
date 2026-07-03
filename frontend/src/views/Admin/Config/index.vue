<template>
  <div class="config-page">

    <!-- 页面标题栏 -->
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">系统配置</h2>
        <p class="page-desc">修改后点击「保存配置」热更新，无需重启服务</p>
      </div>
      <span v-if="configStore.saved" class="saved-badge">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>
        已保存
      </span>
    </div>

    <div class="cards-wrap">

      <!-- ── 数据库 ── -->
      <section id="sec-db" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(123,127,178,0.15);--stroke:#7b7fb2">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="10" cy="5" rx="7" ry="2.5"/>
              <path d="M3 5v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5"/>
              <path d="M3 9v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V9"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>数据库</h3>
            <p>PostgreSQL 连接配置</p>
          </div>
        </div>

        <div class="field-grid">
          <ConfigField label="主机" v-model="draft.db.host" placeholder="localhost" />
          <ConfigField label="端口" v-model.number="draft.db.port" placeholder="5432" type="number" />
          <ConfigField label="数据库名" v-model="draft.db.name" placeholder="gugu_web" />
          <ConfigField label="用户名" v-model="draft.db.user" placeholder="pm" />
          <ConfigField label="密码" v-model="draft.db.password" type="password" placeholder="留空表示不修改" class="span2" />
        </div>

        <div class="card-footer">
          <code class="conn-preview">{{ dbConnString }}</code>
          <div class="test-area">
            <TestResult :status="testStatus.db" />
            <button class="btn-test" :class="{ loading: testLoading.db }" @click="testDb">
              <svg v-if="testLoading.db" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
              </svg>
              {{ testLoading.db ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn-test btn-init" :class="{ loading: initing }" :disabled="initing" @click="initDb" title="重置连接 + 重建所有表（幂等）">
              <svg v-if="initing" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
              </svg>
              {{ initing ? '初始化中…' : '初始化数据库' }}
            </button>
            <button class="btn-test" :class="{ loading: reconciling }" :disabled="reconciling" @click="runReconcile" title="扫描存储 ↔ DB 一致性（只读，不改数据）：幽灵记录 + 孤儿文件">
              <svg v-if="reconciling" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
              </svg>
              {{ reconciling ? '对账中…' : '存储对账' }}
            </button>
          </div>
        </div>

        <!-- 存储 ↔ DB 对账报告（只读） -->
        <div v-if="reconReport" class="recon-report">
          <div v-if="reconReport.error" class="recon-err">对账失败：{{ reconReport.error }}</div>
          <template v-else>
            <div class="recon-summary">
              存储 <b>{{ reconReport.backend }}</b>（{{ reconReport.location }}） ·
              DB 文件 <b>{{ reconReport.db_file_rows }}</b> · 存储对象 <b>{{ reconReport.storage_objects }}</b> ·
              对得上 <b style="color:#5ab899">{{ reconReport.matched }}</b> ·
              幽灵 <b :style="{ color: reconReport.ghost_count ? '#e07676' : 'inherit' }">{{ reconReport.ghost_count }}</b> ·
              孤儿 <b :style="{ color: reconReport.orphan_count ? '#e0a96a' : 'inherit' }">{{ reconReport.orphan_count }}</b>
            </div>
            <div v-if="!reconReport.ghost_count && !reconReport.orphan_count" class="recon-ok">
              ✅ DB 与存储一一对应，无幽灵、无孤儿。
            </div>
            <div v-if="reconReport.ghost_count" class="recon-block">
              <div class="recon-block-title">幽灵记录（DB 有行但物理文件缺失，点开会 404）</div>
              <div v-for="g in reconReport.ghosts" :key="g.id" class="recon-row">
                <span class="recon-name">{{ g.name }}</span>
                <span class="recon-meta">{{ g.space }}{{ g.project ? ' · ' + g.project : '' }}{{ g.deleted ? ' · 回收站' : '' }} · {{ g.storage_key }}</span>
              </div>
            </div>
            <div v-if="reconReport.orphan_count" class="recon-block">
              <div class="recon-block-title">
                孤儿文件（物理文件存在但 DB 无记录，app 里看不见）
                <span class="recon-bulk">
                  <button class="recon-act" :disabled="repairing" @click="repairOrphans(reconReport.orphans, 'import')">全部导入</button>
                  <button class="recon-act recon-act-del" :disabled="repairing" @click="repairOrphans(reconReport.orphans, 'delete')">全部删除</button>
                </span>
              </div>
              <div v-for="o in reconReport.orphans" :key="o" class="recon-row">
                <span class="recon-meta">{{ o }}</span>
                <span class="recon-row-acts">
                  <button class="recon-act" :disabled="repairing" @click="repairOrphans([o], 'import')" title="按路径重建 DB 记录，让它在 app 里现身">导入</button>
                  <button class="recon-act recon-act-del" :disabled="repairing" @click="repairOrphans([o], 'delete')" title="删除物理文件（不可恢复）">删除</button>
                </span>
              </div>
            </div>
            <div v-if="reconReport.truncated" class="recon-meta">（结果较多，列表仅显示前 300 条）</div>
          </template>
        </div>
      </section>

      <!-- ── Redis ── -->
      <section id="sec-redis" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(122,184,200,0.14);--stroke:#7ab8c8">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 2L2 6v8l8 4 8-4V6l-8-4z"/>
              <path d="M2 6l8 4 8-4M10 10v10"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>Redis 缓存</h3>
            <p>会话缓存与实时任务队列</p>
          </div>
        </div>

        <div class="field-grid">
          <ConfigField label="主机" v-model="draft.redis.host" placeholder="localhost" />
          <ConfigField label="端口" v-model.number="draft.redis.port" placeholder="6379" type="number" />
          <ConfigField label="密码" v-model="draft.redis.password" type="password" placeholder="留空表示不修改" class="span2" />
        </div>

        <div class="card-footer">
          <code class="conn-preview">{{ redisConnString }}</code>
          <div class="test-area">
            <TestResult :status="testStatus.redis" />
            <button class="btn-test" :class="{ loading: testLoading.redis }" @click="testRedis">
              <svg v-if="testLoading.redis" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
              </svg>
              {{ testLoading.redis ? '测试中…' : '测试连接' }}
            </button>
          </div>
        </div>
      </section>

      <!-- ── 文件存储 ── -->
      <section id="sec-storage" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(176,120,88,0.12);--stroke:#b07858">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6C3 4.9 3.9 4 5 4h4l2 2h6c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V6z"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>文件存储</h3>
            <p>上传文件的存放位置</p>
          </div>
        </div>

        <div class="toggle-group">
          <button class="toggle-btn" :class="{ active: draft.storage.backend === 'local' }"
            @click="draft.storage.backend = 'local'">本地磁盘</button>
          <button class="toggle-btn" :class="{ active: draft.storage.backend === 'oss' }"
            @click="draft.storage.backend = 'oss'">阿里云 OSS</button>
        </div>

        <div v-if="draft.storage.backend === 'local'" class="field-grid">
          <ConfigField label="存储路径" v-model="draft.storage.local_path" placeholder="./uploads" class="span2" />
        </div>
        <div v-else class="field-grid">
          <ConfigField label="Bucket 名" v-model="draft.storage.oss_bucket" placeholder="gugu-web" />
          <ConfigField label="Endpoint"  v-model="draft.storage.oss_endpoint" placeholder="oss-cn-hangzhou.aliyuncs.com" />
          <ConfigField label="AccessKey ID"     v-model="draft.storage.oss_access_key_id"     type="password" placeholder="留空表示不修改" />
          <ConfigField label="AccessKey Secret" v-model="draft.storage.oss_access_key_secret" type="password" placeholder="留空表示不修改" />
          <ConfigField label="对象前缀" v-model="draft.storage.oss_prefix" placeholder="gugugu/ （选填）" class="span2" />
        </div>

        <div v-if="draft.storage.backend === 'oss'" class="card-footer oss-footer">
          <div class="oss-footer-top">
            <code class="conn-preview">oss://{{ draft.storage.oss_bucket }}.{{ draft.storage.oss_endpoint }}/{{ draft.storage.oss_prefix }}</code>
            <button class="btn-test" :class="{ loading: testLoading.oss }" @click="testOss">
              <svg v-if="testLoading.oss" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
              </svg>
              {{ testLoading.oss ? '测试中…' : '测试 OSS 连接' }}
            </button>
          </div>
          <div v-if="testStatus.oss" class="oss-test-result" :class="testStatus.oss.ok ? 'ok' : 'fail'">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path v-if="testStatus.oss.ok" d="M2 6l2.5 2.5 5.5-5"/>
              <path v-else d="M3 3l6 6M9 3l-6 6"/>
            </svg>
            {{ testStatus.oss.message }}
          </div>
        </div>
      </section>

      <!-- ── 邮件系统 ── -->
      <section id="sec-smtp" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(90,184,153,0.12);--stroke:#5ab899">
            <PhEnvelopeSimple :size="18" />
          </div>
          <div class="card-title-block">
            <h3>邮件系统</h3>
            <p>SMTP 发信配置，用于反馈通知和未来的用户邮件功能</p>
          </div>
        </div>

        <div class="toggle-group">
          <button class="toggle-btn" :class="{ active: draft.smtp.use_ssl }"
            @click="draft.smtp.use_ssl = true; draft.smtp.port = 465">SSL（端口 465）</button>
          <button class="toggle-btn" :class="{ active: !draft.smtp.use_ssl }"
            @click="draft.smtp.use_ssl = false; draft.smtp.port = 587">STARTTLS（端口 587）</button>
        </div>

        <div class="field-grid">
          <ConfigField label="SMTP 服务器" v-model="draft.smtp.host" placeholder="smtp.example.com" />
          <ConfigField label="端口" v-model.number="draft.smtp.port" type="number" placeholder="465" />
          <ConfigField label="登录账号" v-model="draft.smtp.user" placeholder="noreply@example.com" />
          <ConfigField label="登录密码" v-model="draft.smtp.password" type="password" placeholder="留空表示不修改" />
          <ConfigField label="发件人地址" v-model="draft.smtp.from_addr" placeholder="留空则同登录账号" />
          <ConfigField label="通知收件人" v-model="draft.smtp.to_addr" placeholder="admin@example.com" />
        </div>

        <div class="card-footer">
          <code class="conn-preview">{{ draft.smtp.use_ssl ? 'smtps' : 'smtp' }}://{{ draft.smtp.host || 'host' }}:{{ draft.smtp.port }}</code>
          <div class="test-area">
            <TestResult :status="testStatus.smtp" />
            <button class="btn-test" :class="{ loading: testSmtpLoading }" :disabled="testSmtpLoading" @click="testSmtp">
              <svg v-if="testSmtpLoading" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
              </svg>
              {{ testSmtpLoading ? '发送中…' : '测试发送' }}
            </button>
          </div>
        </div>
      </section>

      <!-- ── 保存栏 ── -->
      <div class="save-bar">
        <span class="save-hint" v-if="configStore.saved">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"><path d="M2 6.5l3 3 6-6"/></svg>
          配置热更新成功，无需重启服务
        </span>
        <span class="save-hint error" v-else-if="configStore.saveError">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"><path d="M2 2l9 9M11 2l-9 9"/></svg>
          {{ configStore.saveError }}
        </span>
        <span class="save-hint muted" v-else>密码留空表示不修改，填写新值则覆盖</span>
        <button class="btn-ghost" @click="resetDraft">撤销修改</button>
        <button class="btn-primary" :class="{ loading: configStore.saving }" :disabled="configStore.saving" @click="save">
          <svg v-if="configStore.saving" class="spin-icon" width="13" height="13" viewBox="0 0 12 12"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
          </svg>
          {{ configStore.saving ? '保存中…' : '保存配置' }}
        </button>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, computed, onMounted, defineComponent, h, ref } from 'vue'
import { PhEnvelopeSimple } from '@phosphor-icons/vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import ConfigField from './components/ConfigField.vue'

const configStore = useConfigStore()
const adminStore  = useAdminStore()
const draft = reactive({
  db:      JSON.parse(JSON.stringify(configStore.cfg.db)),
  redis:   JSON.parse(JSON.stringify(configStore.cfg.redis)),
  storage: JSON.parse(JSON.stringify(configStore.cfg.storage)),
  smtp:    JSON.parse(JSON.stringify(configStore.cfg.smtp)),
})

onMounted(async () => {
  await configStore.fetchConfig()
  Object.assign(draft.db,      configStore.cfg.db)
  Object.assign(draft.redis,   configStore.cfg.redis)
  Object.assign(draft.storage, configStore.cfg.storage)
  Object.assign(draft.smtp,    configStore.cfg.smtp)
})

// ── 连接字符串预览 ────────────────────────────────────────────────────────
const dbConnString = computed(() =>
  `postgresql://${draft.db.user}:****@${draft.db.host}:${draft.db.port}/${draft.db.name}`
)
const redisConnString = computed(() => {
  const auth = draft.redis.password ? ':****@' : ''
  return `redis://${auth}${draft.redis.host}:${draft.redis.port}`
})

// ── 连接测试 ──────────────────────────────────────────────────────────────
const testStatus  = reactive({ db: null, redis: null, oss: null, smtp: null })
const testLoading = reactive({ db: false, redis: false, oss: false })
const initing     = ref(false)        // 「初始化数据库」按钮状态

async function testDb() {
  testLoading.db = true
  testStatus.db  = null
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        type: 'db',
        db: {
          host: draft.db.host,
          port: Number(draft.db.port),
          name: draft.db.name,
          user: draft.db.user,
          password: draft.db.password,
        },
      }),
    })
    testStatus.db = await res.json()
  } catch (e) {
    testStatus.db = { ok: false, message: e.message }
  } finally {
    testLoading.db = false
  }
}

// 手动初始化数据库（重建表）。保存配置后会自动调一次，这里是兜底按钮。
async function initDb() {
  if (initing.value) return
  initing.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/init-db', {
      method: 'POST',
    })
    const data = await res.json()
    testStatus.db = data
  } catch (e) {
    testStatus.db = { ok: false, message: e.message }
  } finally {
    initing.value = false
  }
}

// 存储 ↔ DB 对账（只读）：扫存储和 File 表，报告幽灵记录 + 孤儿文件
const reconciling = ref(false)
const reconReport = ref(null)
async function runReconcile() {
  if (reconciling.value) return
  reconciling.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage')
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '对账失败')
    reconReport.value = data
  } catch (e) {
    reconReport.value = { error: e.message }
  } finally {
    reconciling.value = false
  }
}

// 修复孤儿：action=delete 删物理文件 / import 重建 DB 记录
const repairing = ref(false)
async function repairOrphans(keys, action) {
  if (repairing.value || !keys.length) return
  if (action === 'delete' && !window.confirm(`确认删除 ${keys.length} 个孤儿物理文件？此操作不可恢复。`)) return
  repairing.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, keys }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '修复失败')
    const doneSet = new Set(data.done_keys || [])
    if (reconReport.value?.orphans) {
      reconReport.value.orphans = reconReport.value.orphans.filter(k => !doneSet.has(k))
      reconReport.value.orphan_count = reconReport.value.orphans.length
    }
    if (data.failed?.length) window.alert(`${data.done} 个成功，${data.failed.length} 个失败：\n` + data.failed.map(f => `${f.key}: ${f.error}`).join('\n'))
  } catch (e) {
    window.alert('修复失败：' + e.message)
  } finally {
    repairing.value = false
  }
}

async function testRedis() {
  testLoading.redis = true
  testStatus.redis  = null
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        type: 'redis',
        redis: {
          host: draft.redis.host,
          port: Number(draft.redis.port),
          password: draft.redis.password,
        },
      }),
    })
    testStatus.redis = await res.json()
  } catch (e) {
    testStatus.redis = { ok: false, message: e.message }
  } finally {
    testLoading.redis = false
  }
}

async function testOss() {
  testLoading.oss = true
  testStatus.oss  = null
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        type: 'oss',
        oss: {
          endpoint:          draft.storage.oss_endpoint,
          bucket:            draft.storage.oss_bucket,
          access_key_id:     draft.storage.oss_access_key_id,
          access_key_secret: draft.storage.oss_access_key_secret,
          prefix:            draft.storage.oss_prefix,
        },
      }),
    })
    testStatus.oss = await res.json()
  } catch (e) {
    testStatus.oss = { ok: false, message: e.message }
  } finally {
    testLoading.oss = false
  }
}

// ── 内联 TestResult 组件 ──────────────────────────────────────────────────
const TestResult = defineComponent({
  props: { status: Object },
  setup(props) {
    return () => {
      if (!props.status) return null
      const { ok, message } = props.status
      return h('span', {
        class: ok ? 'test-result ok' : 'test-result fail',
      }, [
        h('svg', {
          width: 12, height: 12,
          viewBox: '0 0 12 12', fill: 'none',
          stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
          innerHTML: ok
            ? '<path d="M2 6l2.5 2.5 5.5-5"/>'
            : '<path d="M3 3l6 6M9 3l-6 6"/>',
        }),
        message,
      ])
    }
  },
})

// ── 保存 / 重置 ───────────────────────────────────────────────────────────
async function save() {
  await configStore.saveConfig({
    db:      { ...draft.db },
    redis:   { ...draft.redis },
    storage: { ...draft.storage },
    smtp:    { ...draft.smtp },
  })
}

function resetDraft() {
  Object.assign(draft.db,      configStore.cfg.db)
  Object.assign(draft.redis,   configStore.cfg.redis)
  Object.assign(draft.storage, configStore.cfg.storage)
  Object.assign(draft.smtp,    configStore.cfg.smtp)
  testStatus.db    = null
  testStatus.redis = null
  testStatus.oss   = null
  testStatus.smtp  = null
}

// ── SMTP 测试发送 ──────────────────────────────────────────────────────────
const testSmtpLoading = ref(false)

async function testSmtp() {
  testSmtpLoading.value = true
  testStatus.smtp = null
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/test-smtp', {
      method: 'POST',
      body: JSON.stringify({
        host:      draft.smtp.host,
        port:      Number(draft.smtp.port),
        user:      draft.smtp.user,
        password:  draft.smtp.password,
        from_addr: draft.smtp.from_addr,
        to_addr:   draft.smtp.to_addr,
        use_ssl:   draft.smtp.use_ssl,
      }),
    })
    testStatus.smtp = await res.json()
  } catch (e) {
    testStatus.smtp = { ok: false, message: e.message }
  } finally {
    testSmtpLoading.value = false
  }
}
</script>

<style scoped>
.config-page { min-height: 100%; display: flex; flex-direction: column; }

/* ── 存储对账报告（暗色主题，亮色文字）── */
.recon-report { margin-top: 12px; padding: 12px 14px; border-radius: 10px;
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

/* ── 页面标题 ── */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 32px 36px 0; flex-shrink: 0;
}
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }
.saved-badge {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 600; color: #5ab899;
  background: rgba(90,184,153,0.1); border: 1px solid rgba(90,184,153,0.2);
  padding: 5px 12px; border-radius: 20px; white-space: nowrap;
}

/* ── 卡片区 ── */
.cards-wrap { flex: 1; display: flex; flex-direction: column; gap: 12px; padding: 18px 36px 32px; }

.config-card {
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px;
  padding: 22px 24px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06);
  transition: border-color 0.2s;
}
.config-card:hover { border-color: rgba(255,255,255,0.13); }

.card-head { display: flex; align-items: center; gap: 13px; margin-bottom: 20px; }
.card-icon {
  width: 38px; height: 38px; border-radius: 11px; background: var(--ic);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.card-icon svg { width: 18px; height: 18px; color: var(--stroke); }
.card-title-block { flex: 1; }
.card-title-block h3 { font-size: 14px; font-weight: 700; color: rgba(255,255,255,0.88); }
.card-title-block p  { font-size: 12px; color: rgba(255,255,255,0.38); margin-top: 2px; }

.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field-grid :deep(.span2) { grid-column: span 2; }

.toggle-group { display: flex; gap: 6px; margin-bottom: 16px; }
.provider-grid { flex-wrap: wrap; }
.toggle-btn {
  padding: 6px 18px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.38);
  cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.toggle-btn.active {
  background: rgba(123,127,178,0.2); border-color: rgba(123,127,178,0.35);
  color: rgba(255,255,255,0.88);
}
.toggle-btn:hover:not(.active) { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.6); }

/* ── 卡片底栏 ── */
.card-footer {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 16px; padding-top: 14px;
  border-top: 1px solid rgba(255,255,255,0.07); gap: 12px;
}
.conn-preview {
  font-size: 11px; color: rgba(255,255,255,0.25);
  font-family: 'SF Mono', 'Consolas', monospace;
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.test-area { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.test-result {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 500; padding: 4px 10px; border-radius: 20px;
}
.test-result.ok   { color: #5ab899; background: rgba(90,184,153,0.1); border: 1px solid rgba(90,184,153,0.15); }
.test-result.fail { color: #e07878; background: rgba(224,120,120,0.1); border: 1px solid rgba(224,120,120,0.15); }
.btn-test {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 500; padding: 6px 14px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.07);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.btn-test:hover:not(.loading) { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); color: rgba(255,255,255,0.75); }
.btn-test.loading { opacity: 0.5; cursor: default; }

/* ── 保存栏 ── */
.save-bar {
  display: flex; align-items: center; gap: 10px; padding: 14px 20px;
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 14px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05);
  position: sticky; bottom: 0;
}
.save-hint { flex: 1; font-size: 12px; color: #5ab899; display: flex; align-items: center; gap: 5px; }
.save-hint.muted { color: rgba(255,255,255,0.3); }
.save-hint.error { color: #e07878; }

.btn-ghost {
  padding: 7px 16px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.45); font-size: 13px; cursor: pointer; transition: all 0.15s;
}
.btn-ghost:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }

.btn-primary {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 18px; border-radius: 9px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: opacity 0.15s;
  box-shadow: 0 2px 8px rgba(123,127,178,0.18);
}
.btn-primary:hover:not(:disabled) { opacity: 0.88; }
.btn-primary:disabled { opacity: 0.5; cursor: default; }

.oss-footer { flex-direction: column; align-items: stretch; gap: 10px; }
.oss-footer-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.oss-test-result {
  display: flex; align-items: flex-start; gap: 6px;
  font-size: 12px; font-weight: 500; padding: 8px 12px; border-radius: 9px;
  line-height: 1.5; word-break: break-all;
}
.oss-test-result svg { flex-shrink: 0; margin-top: 2px; }
.oss-test-result.ok   { color: #5ab899; background: rgba(90,184,153,0.1);  border: 1px solid rgba(90,184,153,0.15); }
.oss-test-result.fail { color: #e07878; background: rgba(224,120,120,0.1); border: 1px solid rgba(224,120,120,0.15); }

@keyframes spin { to { transform: rotate(360deg); } }
.spin-icon { animation: spin 0.8s linear infinite; }

</style>
