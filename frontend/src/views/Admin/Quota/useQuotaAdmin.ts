import { computed, onMounted, reactive, ref } from 'vue'

type AdminStore = { authFetch: (url: string, options?: RequestInit) => Promise<Response> }
type ConfigStore = { cfg: any; fetchConfig: () => Promise<unknown>; saveConfig: (value: Record<string, Record<string, unknown>>) => Promise<unknown> }

export function useQuotaAdmin(adminStore: AdminStore, configStore: ConfigStore) {
  const globalDraft = reactive<{ token6h: number | null; tokenWeek: number | null; storageGB: number | null; searchDaily: number | null }>({ token6h: null, tokenWeek: null, storageGB: null, searchDaily: null })
  const globalSaving = ref(false); const globalSaved = ref(false)
  function loadGlobalDraft() {
    const q = configStore.cfg?.quota || {}
    globalDraft.token6h = q.default_token_limit_6h ?? null; globalDraft.tokenWeek = q.default_token_limit_weekly ?? null
    globalDraft.storageGB = q.default_storage_limit_bytes != null ? +(q.default_storage_limit_bytes / 1073741824).toFixed(2) : null
    globalDraft.searchDaily = q.default_search_limit_daily ?? null
  }
  async function saveGlobal() {
    globalSaving.value = true; globalSaved.value = false
    try {
      await configStore.saveConfig({ quota: {
        default_token_limit_6h: globalDraft.token6h != null ? Number(globalDraft.token6h) : null,
        default_token_limit_weekly: globalDraft.tokenWeek != null ? Number(globalDraft.tokenWeek) : null,
        default_storage_limit_bytes: globalDraft.storageGB != null ? Math.round(Number(globalDraft.storageGB) * 1073741824) : null,
        default_search_limit_daily: globalDraft.searchDaily != null ? Number(globalDraft.searchDaily) : null,
      } }); globalSaved.value = true; setTimeout(() => { globalSaved.value = false }, 3000)
    } finally { globalSaving.value = false }
  }
  const allItems = ref<any[]>([]); const loading = ref(false); const refreshing = ref(false); const search = ref('')
  const overrideUsers = computed(() => allItems.value.filter(u => u.token_limit_6h != null || u.token_limit_weekly != null || u.storage_limit_bytes != null || u.search_limit_daily != null))
  const allUsers = computed(() => { const q = search.value.toLowerCase(); return q ? allItems.value.filter(u => (u.username || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)) : allItems.value })
  async function loadUsers(manual = false) {
    if (manual) { refreshing.value = true; setTimeout(() => { refreshing.value = false }, 550) }
    loading.value = true
    try { const res = await adminStore.authFetch('/api/v1/admin/users'); const data = await res.json(); allItems.value = data.items ?? [] }
    finally { loading.value = false }
  }
  function onSearch() { /* 过滤由 allUsers computed 同步完成 */ }
  const editTarget = ref<any | null>(null); const editSaving = ref(false); const maskMousedownSelf = ref(false)
  const editForm = reactive<{ token6h: number | null; tokenWeek: number | null; storageGB: number | null; searchDaily: number | null }>({ token6h: null, tokenWeek: null, storageGB: null, searchDaily: null })
  function openEdit(user: any) { editTarget.value = user; editForm.token6h = user.token_limit_6h ?? null; editForm.tokenWeek = user.token_limit_weekly ?? null; editForm.storageGB = user.storage_limit_bytes != null ? +(user.storage_limit_bytes / 1073741824).toFixed(2) : null; editForm.searchDaily = user.search_limit_daily ?? null }
  async function saveEdit() {
    if (!editTarget.value) return; editSaving.value = true
    try {
      const body = { token_limit_6h: editForm.token6h != null ? Number(editForm.token6h) : null, token_limit_weekly: editForm.tokenWeek != null ? Number(editForm.tokenWeek) : null, storage_limit_bytes: editForm.storageGB != null ? Math.round(Number(editForm.storageGB) * 1073741824) : null, search_limit_daily: editForm.searchDaily != null ? Number(editForm.searchDaily) : null }
      const res = await adminStore.authFetch(`/api/v1/admin/users/${editTarget.value.id}/quota`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await res.json()
      editTarget.value.token_limit_6h = data.token_limit_6h; editTarget.value.token_limit_weekly = data.token_limit_weekly; editTarget.value.storage_limit_bytes = data.storage_limit_bytes; editTarget.value.search_limit_daily = data.search_limit_daily; editTarget.value = null
    } finally { editSaving.value = false }
  }
  async function clearQuota(user: any) {
    await adminStore.authFetch(`/api/v1/admin/users/${user.id}/quota`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token_limit_6h: null, token_limit_weekly: null, storage_limit_bytes: null, search_limit_daily: null }) })
    user.token_limit_6h = null; user.token_limit_weekly = null; user.storage_limit_bytes = null; user.search_limit_daily = null
  }
  const colors = [['#5a6b9e', '#8490c4'], ['#5a8e7e', '#7cbfad'], ['#8e6a5a', '#c49078'], ['#6a5a8e', '#9878c4'], ['#5a7e8e', '#78b0bf']]
  const avatarChar = (u: any) => (u.display_name || u.username || '?').charAt(0).toUpperCase()
  const avatarStyle = (u: any) => { const [c1, c2] = colors[(u.username || '?').charCodeAt(0) % colors.length]; return { background: `linear-gradient(135deg, ${c1}, ${c2})` } }
  const fmtTokens = (n: number) => n == null ? '—' : n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
  const fmtBytes = (n: number) => !n ? '—' : n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B'
  const tokenBarStyle = (u: any) => { const pct = u.token_limit_weekly ? Math.min(100, (u.tokens_week / u.token_limit_weekly) * 100) : 0; return { width: pct + '%', background: pct >= 90 ? 'rgba(220,80,80,0.85)' : pct >= 70 ? 'rgba(220,160,60,0.85)' : 'rgba(80,160,200,0.75)' } }
  const storageBarStyle = (u: any) => { const pct = u.storage_limit_bytes ? Math.min(100, (u.storage_used / u.storage_limit_bytes) * 100) : 0; return { width: pct + '%', background: pct >= 90 ? 'rgba(220,80,80,0.85)' : pct >= 70 ? 'rgba(220,160,60,0.85)' : 'rgba(80,200,140,0.75)' } }
  onMounted(async () => { await configStore.fetchConfig(); loadGlobalDraft(); void loadUsers() })
  return { globalDraft, globalSaving, globalSaved, saveGlobal, allItems, loading, refreshing, search, onSearch, overrideUsers, allUsers, loadUsers, editTarget, editSaving, maskMousedownSelf, editForm, openEdit, saveEdit, clearQuota, avatarChar, avatarStyle, fmtTokens, fmtBytes, tokenBarStyle, storageBarStyle }
}
