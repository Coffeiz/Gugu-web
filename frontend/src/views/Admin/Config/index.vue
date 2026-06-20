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
          <ConfigField label="数据库名" v-model="draft.db.name" placeholder="pm_studio" />
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
          <ConfigField label="Bucket 名" v-model="draft.storage.oss_bucket" placeholder="pm-studio" />
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

      <!-- ── AI ── -->
      <section id="sec-ai" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(196,175,200,0.14);--stroke:#9590c4">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 2l1.5 4h4l-3.3 2.4 1.3 4L10 10l-3.5 2.4 1.3-4L4.5 6h4z"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>AI 配置</h3>
            <p>Agent 使用的模型与 API 密钥</p>
          </div>
        </div>

        <div class="toggle-group provider-grid">
          <button class="toggle-btn" :class="{ active: draft.ai.provider === 'openai' }"
            @click="setProvider('openai')">OpenAI 兼容</button>
          <button class="toggle-btn" :class="{ active: draft.ai.provider === 'anthropic' }"
            @click="setProvider('anthropic')">Anthropic 兼容</button>
          <button class="toggle-btn" :class="{ active: draft.ai.provider === 'qwen' }"
            @click="setProvider('qwen')">通义千问</button>
          <button class="toggle-btn" :class="{ active: draft.ai.provider === 'deepseek' }"
            @click="setProvider('deepseek')">DeepSeek</button>
          <button class="toggle-btn" :class="{ active: draft.ai.provider === 'minimax' }"
            @click="setProvider('minimax')">MiniMax</button>
        </div>

        <div class="field-grid">
          <ConfigField label="API Key"  v-model="draft.ai.api_key"  type="password" placeholder="留空表示不修改" class="span2" />
          <ConfigField label="Base URL" v-model="draft.ai.base_url" placeholder="https://…" class="span2" />
          <ConfigField label="模型名称" v-model="draft.ai.model"    placeholder="qwen-max" />
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

<script setup>
import { reactive, computed, onMounted, defineComponent, h, ref } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import ConfigField from './components/ConfigField.vue'

const configStore = useConfigStore()
const adminStore  = useAdminStore()
const draft = reactive(JSON.parse(JSON.stringify(configStore.cfg)))

onMounted(async () => {
  await configStore.fetchConfig()
  Object.assign(draft.db,      configStore.cfg.db)
  Object.assign(draft.redis,   configStore.cfg.redis)
  Object.assign(draft.storage, configStore.cfg.storage)
  Object.assign(draft.ai,      configStore.cfg.ai)
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
const testStatus  = reactive({ db: null, redis: null, oss: null })
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
const AI_PRESETS = {
  qwen:     { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  openai:   { base_url: 'https://api.openai.com/v1',                         model: 'gpt-4o' },
  deepseek: { base_url: 'https://api.deepseek.com',                          model: 'deepseek-chat' },
  minimax:  { base_url: 'https://api.minimaxi.com/anthropic',                 model: 'MiniMax-M3' },
  anthropic:{ base_url: 'https://api.anthropic.com/v1',                      model: 'claude-opus-4-8' },
}

function setProvider(p) {
  draft.ai.provider = p
  const preset = AI_PRESETS[p]
  if (preset) {
    draft.ai.base_url = preset.base_url
    draft.ai.model    = preset.model
  }
}

async function save() {
  await configStore.saveConfig({
    db:      { ...draft.db },
    redis:   { ...draft.redis },
    storage: { ...draft.storage },
    ai:      { ...draft.ai },
  })
}

function resetDraft() {
  Object.assign(draft.db,      configStore.cfg.db)
  Object.assign(draft.redis,   configStore.cfg.redis)
  Object.assign(draft.storage, configStore.cfg.storage)
  Object.assign(draft.ai,      configStore.cfg.ai)
  testStatus.db    = null
  testStatus.redis = null
  testStatus.oss   = null
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

.toggle-group { display: flex; gap: 6px; margin-bottom: 16px; }
.provider-grid { flex-wrap: wrap; }
.toggle-btn {
  padding: 6px 18px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.38);
  cursor: pointer; transition: all 0.15s;
}
.toggle-btn.active {
  background: rgba(123,127,178,0.2); border-color: rgba(123,127,178,0.35);
  color: rgba(255,255,255,0.88); font-weight: 600;
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
