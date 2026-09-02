<template>
  <div class="config-page">

    <!-- 页面标题栏 -->
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ t('adminConfig.title') }}</h2>
        <p class="page-desc">{{ t('adminConfig.description') }}</p>
      </div>
      <span v-if="configStore.saved" class="saved-badge">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>
        {{ t('adminConfig.saved') }}
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
            <h3>{{ t('configUi.database') }}</h3>
            <p>{{ t('configUi.postgresHint') }}</p>
          </div>
        </div>

        <div class="field-grid">
          <ConfigField :label="t('configUi.host')" v-model="draft.db.host" placeholder="localhost" />
          <ConfigField :label="t('configUi.port')" v-model.number="draft.db.port" placeholder="5432" type="number" />
          <ConfigField :label="t('configUi.databaseName')" v-model="draft.db.name" placeholder="gugu_web" />
          <ConfigField :label="t('configUi.username')" v-model="draft.db.user" placeholder="pm" />
          <ConfigField :label="t('configUi.password')" v-model="draft.db.password" type="password" :placeholder="t('configUi.keepUnchanged')" class="span2" />
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
              {{ testLoading.db ? t('configUi.testing') : t('configUi.test') }}
            </button>
            <button class="btn-test btn-init" :class="{ loading: initing }" :disabled="initing" @click="initDb" :title="t('configUi.initTitle')">
              <svg v-if="initing" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
              </svg>
              {{ initing ? t('configUi.initializing') : t('configUi.init') }}
            </button>
          </div>
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
            <h3>{{ t('configUi.redis') }}</h3>
            <p>{{ t('configUi.redisHint') }}</p>
          </div>
        </div>

        <div class="field-grid">
          <ConfigField :label="t('configUi.host')" v-model="draft.redis.host" placeholder="localhost" />
          <ConfigField :label="t('configUi.port')" v-model.number="draft.redis.port" placeholder="6379" type="number" />
          <ConfigField :label="t('configUi.password')" v-model="draft.redis.password" type="password" :placeholder="t('configUi.keepUnchanged')" class="span2" />
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
              {{ testLoading.redis ? t('configUi.testing') : t('configUi.test') }}
            </button>
          </div>
        </div>
      </section>

      <!-- ── 站内搜索 ── -->
      <section id="sec-search" class="config-card search-config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(122,184,200,0.15);--stroke:#7ab8c8">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.5 12.5L17 17"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>{{ t('configUi.globalSearch') }}</h3>
            <p>{{ t('configUi.globalSearchHint') }}</p>
          </div>
          <div class="search-provider-group">
            <AdminSelect
              class="search-provider-select"
              :model-value="draft.search.global_search_backend"
              :options="[
                { value: 'index', label: t('configUi.persistentIndex') },
                { value: 'ilike', label: t('configUi.ilike') },
              ]"
              :aria-label="t('configUi.searchLabel')"
              @update:model-value="draft.search.global_search_backend = $event"
            />
            <p class="config-card-note">{{ t('configUi.searchHint') }}</p>
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
            <h3>{{ t('configUi.fileStorage') }}</h3>
            <p>{{ t('configUi.fileStorageHint') }}</p>
          </div>
        </div>

        <div class="toggle-group">
          <button class="toggle-btn" :class="{ active: draft.storage.backend === 'local' }"
            @click="draft.storage.backend = 'local'">{{ t('configUi.localDisk') }}</button>
          <button class="toggle-btn" :class="{ active: draft.storage.backend === 'oss' }"
            @click="draft.storage.backend = 'oss'">{{ t('configUi.aliyunOss') }}</button>
        </div>

        <div v-if="draft.storage.backend === 'local'" class="field-grid">
          <ConfigField :label="t('configUi.storagePath')" v-model="draft.storage.local_path" placeholder="../Gugu-data/users" class="span2" />
        </div>
        <div v-else class="field-grid">
          <ConfigField :label="t('configUi.bucketName')" v-model="draft.storage.oss_bucket" placeholder="gugu-web" />
          <ConfigField label="Endpoint"  v-model="draft.storage.oss_endpoint" placeholder="oss-cn-hangzhou.aliyuncs.com" />
          <ConfigField label="AccessKey ID"     v-model="draft.storage.oss_access_key_id" type="password" :placeholder="t('configUi.keepUnchanged')" />
          <ConfigField label="AccessKey Secret" v-model="draft.storage.oss_access_key_secret" type="password" :placeholder="t('configUi.keepUnchanged')" />
          <ConfigField :label="t('configUi.objectPrefix')" v-model="draft.storage.oss_prefix" :placeholder="`gugugu/ ${t('configUi.optionalSuffix')}`" class="span2" />
        </div>

        <div v-if="draft.storage.backend === 'oss'" class="card-footer oss-footer">
          <div class="oss-footer-top">
            <code class="conn-preview">oss://{{ draft.storage.oss_bucket }}.{{ draft.storage.oss_endpoint }}/{{ draft.storage.oss_prefix }}</code>
            <button class="btn-test" :class="{ loading: testLoading.oss }" @click="testOss">
              <svg v-if="testLoading.oss" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
              </svg>
              {{ testLoading.oss ? t('configUi.testing') : t('configUi.testOss') }}
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
            <Icon name="admin.mail" size="md" />
          </div>
          <div class="card-title-block">
            <h3>{{ t('configUi.mailSystem') }}</h3>
            <p>{{ t('configUi.mailHint') }}</p>
          </div>
        </div>

        <div class="toggle-group">
          <button class="toggle-btn" :class="{ active: draft.smtp.use_ssl }"
            @click="draft.smtp.use_ssl = true; draft.smtp.port = 465">{{ t('configUi.ssl') }}</button>
          <button class="toggle-btn" :class="{ active: !draft.smtp.use_ssl }"
            @click="draft.smtp.use_ssl = false; draft.smtp.port = 587">{{ t('configUi.starttls') }}</button>
        </div>

        <div class="field-grid">
          <ConfigField :label="t('configUi.smtpServer')" v-model="draft.smtp.host" placeholder="smtp.example.com" />
          <ConfigField :label="t('configUi.port')" v-model.number="draft.smtp.port" type="number" placeholder="465" />
          <ConfigField :label="t('configUi.account')" v-model="draft.smtp.user" placeholder="noreply@example.com" />
          <ConfigField :label="t('configUi.loginPassword')" v-model="draft.smtp.password" type="password" :placeholder="t('configUi.keepUnchanged')" />
          <ConfigField :label="t('configUi.sender')" v-model="draft.smtp.from_addr" :placeholder="t('configUi.senderKeep')" />
          <ConfigField :label="t('configUi.testRecipient')" v-model="draft.smtp.test_to_addr" placeholder="test@example.com" type="email" />
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
              {{ testSmtpLoading ? t('configUi.sending') : t('configUi.sendTest') }}
            </button>
          </div>
        </div>
      </section>

      <!-- ── 用户反馈邮件 ── -->
      <FeedbackEmailSettings
        v-model:enabled="draft.smtp.feedback_email_enabled"
        v-model:email="draft.smtp.to_addr"
      />

      <!-- ── 安全告警 ── -->
      <SecurityAlertSettings v-model="draft.security" />

      <!-- ── 保存栏 ── -->
      <div class="save-bar">
        <span class="save-hint" v-if="configStore.saved">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"><path d="M2 6.5l3 3 6-6"/></svg>
          {{ t('adminConfig.hotUpdated') }}
        </span>
        <span class="save-hint error" v-else-if="configStore.saveError">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"><path d="M2 2l9 9M11 2l-9 9"/></svg>
          {{ configStore.saveError }}
        </span>
        <span class="save-hint muted" v-else>{{ t('configUi.saveHint') }}</span>
        <button class="btn-ghost" @click="resetDraft">{{ t('configUi.undo') }}</button>
        <button class="btn-primary" :class="{ loading: configStore.saving }" :disabled="configStore.saving" @click="save">
          <svg v-if="configStore.saving" class="spin-icon" width="13" height="13" viewBox="0 0 12 12"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
          </svg>
          {{ configStore.saving ? t('common.status.saving') : t('adminConfig.save') }}
        </button>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, computed, onMounted, defineComponent, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import AdminSelect from '@/components/AdminSelect.vue'
import ConfigField from './components/ConfigField.vue'
import FeedbackEmailSettings from './components/FeedbackEmailSettings.vue'
import SecurityAlertSettings from './components/SecurityAlertSettings.vue'

const { t } = useI18n()

const configStore = useConfigStore()
const adminStore  = useAdminStore()
const draft = reactive({
  db:      JSON.parse(JSON.stringify(configStore.cfg.db)),
  redis:   JSON.parse(JSON.stringify(configStore.cfg.redis)),
  search:  JSON.parse(JSON.stringify(configStore.cfg.search)),
  storage: JSON.parse(JSON.stringify(configStore.cfg.storage)),
  smtp:    JSON.parse(JSON.stringify(configStore.cfg.smtp)),
  security: JSON.parse(JSON.stringify(configStore.cfg.security ?? {
    alert_email_enabled: false,
    alert_email_recipients: [],
  })),
})

onMounted(async () => {
  await configStore.fetchConfig()
  Object.assign(draft.db,      configStore.cfg.db)
  Object.assign(draft.redis,   configStore.cfg.redis)
  Object.assign(draft.search,  configStore.cfg.search)
  Object.assign(draft.storage, configStore.cfg.storage)
  Object.assign(draft.smtp,    configStore.cfg.smtp)
  Object.assign(draft.security, configStore.cfg.security ?? { alert_email_enabled: false, alert_email_recipients: [] })
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
const testStatus  = reactive<Record<string, any>>({ db: null, redis: null, oss: null, smtp: null })
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
    testStatus.db = { ok: false, message: (e instanceof Error ? e.message : String(e)) }
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
    testStatus.db = { ok: false, message: (e instanceof Error ? e.message : String(e)) }
  } finally {
    initing.value = false
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
    testStatus.redis = { ok: false, message: (e instanceof Error ? e.message : String(e)) }
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
    testStatus.oss = { ok: false, message: (e instanceof Error ? e.message : String(e)) }
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
    search:  { global_search_backend: draft.search.global_search_backend },
    storage: { ...draft.storage },
    smtp:    { ...draft.smtp },
    security: { ...draft.security },
  })
}

function resetDraft() {
  Object.assign(draft.db,      configStore.cfg.db)
  Object.assign(draft.redis,   configStore.cfg.redis)
  Object.assign(draft.search,  configStore.cfg.search)
  Object.assign(draft.storage, configStore.cfg.storage)
  Object.assign(draft.smtp,    configStore.cfg.smtp)
  Object.assign(draft.security, configStore.cfg.security ?? { alert_email_enabled: false, alert_email_recipients: [] })
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
        to_addr:   draft.smtp.test_to_addr,
        use_ssl:   draft.smtp.use_ssl,
      }),
    })
    testStatus.smtp = await res.json()
  } catch (e) {
    testStatus.smtp = { ok: false, message: (e instanceof Error ? e.message : String(e)) }
  } finally {
    testSmtpLoading.value = false
  }
}
</script>

<style scoped>
.config-page { min-height: 100%; display: flex; flex-direction: column; }

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

.search-provider-group { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; margin-left: auto; min-width: 0; }
.config-card-note { margin: 0; color: rgba(255,255,255,0.35); font-size: 12px; line-height: 1.5; text-align: right; }
.search-provider-select { flex-shrink: 0; }
.search-config-card .card-head { margin-bottom: 0; }

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
.toggle-btn { display: inline-flex; flex-direction: column; align-items: center; }
.toggle-btn[data-label]::after { content: attr(data-label); height: 0; overflow: hidden; visibility: hidden; font-weight: 600; }
.toggle-btn:hover:not(.active) { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.6); }

/* ── 卡片底栏 ── */
.card-footer {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 16px; padding-top: 14px;
  border-top: 1px solid rgba(255,255,255,0.07); gap: 12px;
}
.conn-preview {
  font-size: 11px; color: rgba(255,255,255,0.25);
  font-family: var(--font-family-mono);
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
  position: sticky; bottom: 12px;
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
  background: var(--action-primary-bg);
  color: white; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: opacity 0.15s;
  box-shadow: none;
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
