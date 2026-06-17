import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { useAdminStore } from './admin'

// 后端对密码类字段返回 "****"，前端拿到后清空，存回时跳过空值（视为"未修改"）
const PASSWORD_FIELDS = new Set(['password', 'api_key', 'oss_access_key_id', 'oss_access_key_secret'])

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

  const cfg = reactive({
    db: {
      host: 'localhost',
      port: 5432,
      name: 'pm_studio',
      user: 'pm',
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
      oss_bucket: 'pm-studio',
      oss_endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      oss_prefix: '',
    },
    ai: {
      provider: 'qwen',
      api_key: '',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-max',
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
    const cleanPatch = {}
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
      saved.value = true
      setTimeout(() => { saved.value = false }, 3000)
    } catch (e) {
      saveError.value = e.message
      setTimeout(() => { saveError.value = '' }, 5000)
    } finally {
      saving.value = false
    }
  }

  return { cfg, loading, saving, saved, saveError, fetchConfig, saveConfig }
})
