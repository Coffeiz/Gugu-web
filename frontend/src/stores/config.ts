import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { useAdminStore } from './admin'

// 后端对密码类字段返回 "****"，前端拿到后清空，存回时跳过空值（视为"未修改"）
const PASSWORD_FIELDS = new Set(['password', 'api_key', 'oss_access_key_id', 'oss_access_key_secret', 'tavily_api_key', 'baidu_qianfan_api_key'])

function sanitizeForEdit(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = (PASSWORD_FIELDS.has(k) && v === '****') ? '' : v
  }
  return out
}

function stripUnchangedPasswords(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
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
  const secretSet = reactive({ voiceApiKey: false, embeddingApiKey: false })

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
      api_key: '',
      base_url: '',
      model: '',
      api_format: 'openai',
      dashscope_service: 'qwen3-asr',
    },
    embedding: {
      enabled: false,
      multimodal: false,
      provider: '',
      api_key: '',
      base_url: '',
      model: '',
      dimensions: 0,
    },
    agent: {
      memory_enabled: true,
      reflection_threshold: 10,
      worker_concurrency: 16,
      conv_compress_enabled: true,
      im_progress_announce_enabled: true,
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
      searxng_image_engines: '',
      max_results: 5,
      similar_image_enabled: false,
      baidu_qianfan_api_key: '',
      similar_image_default_count: 10,
      similar_image_timeout_seconds: 20,
      similar_image_limit_daily: 10,
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
      if (data.embedding) { secretSet.embeddingApiKey = data.embedding.api_key === '****'; Object.assign(cfg.embedding, sanitizeForEdit(data.embedding)) }
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

  async function saveConfig(patch: Record<string, Record<string, unknown>>) {
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
        const target = (cfg as Record<string, Record<string, unknown>>)[section]
        if (target) Object.assign(target, vals)
      }
      if (cleanPatch.voice?.api_key) secretSet.voiceApiKey = true   // 这次确实写了新 key
      if (cleanPatch.embedding?.api_key) secretSet.embeddingApiKey = true
      saved.value = true
      setTimeout(() => { saved.value = false }, 3000)
    } catch (e) {
      saveError.value = e instanceof Error ? e.message : String(e)
      setTimeout(() => { saveError.value = '' }, 5000)
    } finally {
      saving.value = false
    }
  }

  return { cfg, loading, saving, saved, saveError, secretSet, fetchConfig, saveConfig }
})
