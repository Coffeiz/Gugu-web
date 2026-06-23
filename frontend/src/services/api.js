/**
 * 咕咕 API 客户端
 * 所有请求统一走这里，自动附加 user Bearer token
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

export function getToken() {
  return localStorage.getItem('user_token') ?? ''
}

async function request(method, path, body = null, isForm = false) {
  const token = getToken()
  const opts = {
    method,
    headers: {},
  }

  if (token) {
    opts.headers['Authorization'] = `Bearer ${token}`
  }

  if (body !== null) {
    if (isForm) {
      opts.body = body
    } else {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
  }

  const res = await fetch(`${BASE_URL}${path}`, opts)

  if (!res.ok) {
    // token 失效时自动清除并跳转登录
    if (res.status === 401) {
      localStorage.removeItem('user_token')
      window.location.href = '/login'
      throw new Error('请重新登录')
    }
    const err = await res.json().catch(() => ({}))
    const d = err.detail
    const msg = !d ? `HTTP ${res.status}`
      : typeof d === 'string' ? d
      : Array.isArray(d) ? d.map(e => e.msg ?? e).join('；')
      : `HTTP ${res.status}`
    const apiErr = new Error(msg)
    apiErr.status = res.status
    throw apiErr
  }

  if (res.status === 204) return null
  return res.json()
}

const get    = (path)        => request('GET',    path)
const post   = (path, body)  => request('POST',   path, body)
const patch  = (path, body)  => request('PATCH',  path, body)
const del    = (path)        => request('DELETE', path)
const upload = (path, form)  => request('POST',   path, form, true)

export function uploadWithProgress(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}${path}`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch { resolve(null) }
      } else {
        try {
          const d = JSON.parse(xhr.responseText).detail
          const msg = !d ? `HTTP ${xhr.status}`
            : typeof d === 'string' ? d
            : Array.isArray(d) ? d.map(e => e.msg ?? e).join('；')
            : `HTTP ${xhr.status}`
          reject(new Error(msg))
        } catch { reject(new Error(`HTTP ${xhr.status}`)) }
      }
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    xhr.send(form)
  })
}

// ── Projects ─────────────────────────────────────────────────────────────────
export const projectsApi = {
  list:   ()         => get('/projects'),
  get:    (id)       => get(`/projects/${id}`),
  create: (data)     => post('/projects', data),
  update: (id, data) => patch(`/projects/${id}`, data),
  delete: (id)       => del(`/projects/${id}`),
}

// ── Files ─────────────────────────────────────────────────────────────────────
export const filesApi = {
  list: ({ space, projectId, folderId, mindMapId, ext, q } = {}) => {
    const p = {}
    if (space      != null) p.space       = space
    if (projectId  != null) p.project_id  = projectId
    if (folderId   != null) p.folder_id   = folderId
    if (mindMapId  != null) p.mind_map_id = mindMapId
    if (ext        != null) p.ext         = ext
    if (q          != null) p.q           = q
    const qs = new URLSearchParams(p).toString()
    return get(`/files${qs ? '?' + qs : ''}`)
  },
  tree:    ()         => get('/files/tree'),
  all:     ()         => get('/files/all'),
  version: ()         => get('/files/version'),
  storage: ()         => get('/files/storage'),
  update: (id, data) => patch(`/files/${id}`, data),
  delete:      (id)   => del(`/files/${id}`),
  batchDelete: (ids)  => post('/files/batch-delete', { ids }),
  copy: (id, body) => post(`/files/${id}/copy`, body),
  batchDownload: async (ids, folderIds = [], filename = 'files.zip') => {
    const token = getToken()
    const res = await fetch(`${BASE_URL}/files/batch-download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ids, folderIds }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  },
  // 返回 { url: "https://..." }，后端签名 URL，有效期短（5~10 分钟）
  getStreamUrl: (id) => get(`/files/${id}/stream-url`),
  download: async (id, filename) => {
    const token = getToken()
    const res = await fetch(`${BASE_URL}/files/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  },
}

// ── Events ────────────────────────────────────────────────────────────────────
export const eventsApi = {
  list:   (year, month) => get(`/events?year=${year}&month=${month}`),
  create: (data)        => post('/events', data),
  update: (id, data)    => patch(`/events/${id}`, data),
  delete: (id)          => del(`/events/${id}`),
}

// ── Folders ───────────────────────────────────────────────────────────────────
export const foldersApi = {
  all:  ()                              => get('/folders/all'),
  list: ({ projectId, parentId } = {}) => {
    const params = new URLSearchParams()
    if (projectId != null) params.set('project_id', projectId)
    if (parentId  != null) params.set('parent_id',  parentId)
    const qs = params.toString()
    return get(qs ? `/folders?${qs}` : '/folders')
  },
  create: (projectId, name, parentId = null) => post('/folders', {
    ...(projectId != null ? { projectId } : {}),
    ...(parentId  != null ? { parentId  } : {}),
    name,
  }),
  rename: (id, name)     => patch(`/folders/${id}`, { name }),
  move:   (id, parentId) => patch(`/folders/${id}/parent`, { parentId }),
  delete: (id)           => del(`/folders/${id}`),
  download: async (id, name) => {
    const token = getToken()
    const res = await fetch(`${BASE_URL}/folders/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.zip`
    a.click()
    URL.revokeObjectURL(url)
  },
}

// ── Trash ─────────────────────────────────────────────────────────────────────
export const trashApi = {
  list:         ()    => get('/trash'),
  restore:      (id)  => post(`/trash/${id}/restore`, {}),
  hardDelete:   (id)  => del(`/trash/${id}`),
  empty:        ()    => del('/trash'),
}

// ── Clients ────────────────────────────────────────────────────────────────────
export const clientsApi = {
  list:   ()         => get('/clients'),
  create: (data)     => post('/clients', data),
  delete: (id)       => del(`/clients/${id}`),
}

export const preferencesApi = {
  get:    ()     => get('/preferences'),
  update: (data) => request('PATCH', '/preferences', data),
}

export const agentApi = {
  listSessions:    ()           => get('/agent/sessions'),
  getMessages:     (sessionId) => get(`/agent/sessions/${sessionId}/messages`),
  deleteSession:   (sessionId) => del(`/agent/sessions/${sessionId}`),
}

export const authApi = {
  updateProfile: (data) => request('PATCH', '/auth/profile', data),
  getQuota:      ()     => request('GET',   '/auth/quota'),
  uploadAvatar:  (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('POST', '/auth/avatar', fd, true)
  },
}

// 飞书 OAuth 扫码绑定
// 用户自带机器人（BYO：飞书 / QQ）
export const userBotsApi = {
  list:   ()        => request('GET',    '/me/bots'),
  create: (body)    => request('POST',   '/me/bots', body),
  update: (id, body)=> request('PUT',    `/me/bots/${id}`, body),
  remove: (id)      => request('DELETE', `/me/bots/${id}`),
}

// QQ 扫码自动连接（建 task → 轮询 → 自动填 key）
export const qqConnectApi = {
  start: ()        => request('POST', '/me/qq/connect'),
  poll:  (taskId)  => request('GET',  `/me/qq/connect/${taskId}`),
}

// 飞书扫码自动连接（device flow → 轮询 → 自动填 key）
export const feishuConnectApi = {
  start: ()        => request('POST', '/me/feishu/connect'),
  poll:  (pollId)  => request('GET',  `/me/feishu/connect/${pollId}`),
}
