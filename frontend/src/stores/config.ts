import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { useAdminStore } from './admin'

// 后端对密码类字段返回 "****"，前端拿到后清空，存回时跳过空值（视为"未修改"）
const PASSWORD_FIELDS = new Set(['password', 'api_key', 'oss_access_key_id', 'oss_access_key_secret', 'tavily_api_key'])

function sanitizeForEdit(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = (PASSWORD_FIELDS.has(k) && v === '****') ? '' : v
  }
  return out
}

function stripUnchangedPasswords(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (PASSWORD_FIELDS.has(k) && (!v || v === '****')) continue
    out[k] = v
  }
  return out
}

export const useConfigStore = defineStore('config', () => {
  const loading   = ref(false)
  const saving    = ref(false)
  const saved     = ref(false)
  const saveError = ref('')
  // 后端把已存的密钥脱敏成 ****、前端又清空显示，导致「已存」无任何痕迹 → 看着像没保存。
  // 这里记录各保密字段后端当前是否已有值，供 UI 显示「已配置」指示。
  const secretSet = reactive({ voiceApiKey: false })

  const cfg = reactive({
    db: {
      host: 'localhost',
      port: 5432,
      name: 'gugu_web',
      user: 'gugu',
      password: '',
    },
    redis: {
      host: 'localhost',
      port: 6379,
      password: '',
    },
    storage: {
      backend: 'local',
      local_path: './uploads',
      oss_access_key_id: '',
      oss_access_key_secret: '',
      oss_bucket: 'gugu-web',
      oss_endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      oss_prefix: '',
    },
    ai: {
      provider: 'qwen',
      api_key: '',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-max',
    },
    voice: {
      provider: '',
      api_key: '',
      base_url: '',
      model: '',
      api_format: 'openai',
    },
    agent: {
      memory_enabled: true,
      reflection_threshold: 10,
      daily_retention_days: 14,
      weekly_retention_weeks: 6,
    },
    quota: {
      default_token_limit_6h: null,
      default_token_limit_weekly: null,
      default_storage_limit_bytes: null,
      default_search_limit_daily: null,
    },
    search: {
      tavily_api_key: '',
      searxng_url: '',
      searxng_engines: 'sogou,quark,360search',
      max_results: 5,
    },
    smtp: {
      host: '',
      port: 465,
      user: '',
      password: '',
      from_addr: '',
      to_addr: '',
      use_ssl: true,
    },
  })

  async function fetchConfig() {
    loading.value = true
    const adminStore = useAdminStore()
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config')
      const { data } = await res.json()
      if (data.db)      Object.assign(cfg.db,      sanitizeForEdit(data.db))
      if (data.redis)   Object.assign(cfg.redis,   sanitizeForEdit(data.redis))
      if (data.storage) Object.assign(cfg.storage, sanitizeForEdit(data.storage))
      if (data.ai)      Object.assign(cfg.ai,      sanitizeForEdit(data.ai))
      if (data.voice) { secretSet.voiceApiKey = data.voice.api_key === '****'; Object.assign(cfg.voice, sanitizeForEdit(data.voice)) }
      if (data.agent)   Object.assign(cfg.agent,   data.agent)
      if (data.quota)   Object.assign(cfg.quota,   data.quota)
      if (data.search)  Object.assign(cfg.search,  sanitizeForEdit(data.search))
      if (data.smtp)    Object.assign(cfg.smtp,    sanitizeForEdit(data.smtp))
    } catch {
      // 后端未启动时静默，使用默认值
    } finally {
      loading.value = false
    }
  }

  async function saveConfig(patch) {
    saving.value = true
    saved.value  = false
    saveError.value = ''
    const adminStore = useAdminStore()
    const cleanPatch: Record<string, any> = {}
    for (const [section, vals] of Object.entries(patch)) {
      cleanPatch[section] = stripUnchangedPasswords(vals)
    }
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({ patch: cleanPatch }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `保存失败（${res.status}）`)
      }
      for (const [section, vals] of Object.entries(cleanPatch)) {
        if (cfg[section]) Object.assign(cfg[section], vals)
      }
      if (cleanPatch.voice?.api_key) secretSet.voiceApiKey = true   // 这次确实写了新 key
      saved.value = true
      setTimeout(() => { saved.value = false }, 3000)
    } catch (e) {
      saveError.value = e.message
      setTimeout(() => { saveError.value = '' }, 5000)
    } finally {
      saving.value = false
    }
  }

  return { cfg, loading, saving, saved, saveError, secretSet, fetchConfig, saveConfig }
})
