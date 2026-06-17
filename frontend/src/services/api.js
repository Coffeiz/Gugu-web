/**
 * PM Studio API 客户端
 * 所有请求统一走这里，自动附加 user Bearer token
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

function getToken() {
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
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
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
        try { reject(new Error(JSON.parse(xhr.responseText).detail ?? `HTTP ${xhr.status}`)) }
        catch { reject(new Error(`HTTP ${xhr.status}`)) }
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
  tree:   ()         => get('/files/tree'),
  update: (id, data) => patch(`/files/${id}`, data),
  delete:      (id)   => del(`/files/${id}`),
  batchDelete: (ids)  => post('/files/batch-delete', { ids }),
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
  list:   (projectId)       => get(projectId != null ? `/folders?project_id=${projectId}` : '/folders'),
  create: (projectId, name) => post('/folders', { ...(projectId != null ? { project_id: projectId } : {}), name }),
  rename: (id, name)        => patch(`/folders/${id}`, { name }),
  delete: (id)              => del(`/folders/${id}`),
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
