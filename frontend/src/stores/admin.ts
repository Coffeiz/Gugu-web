import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getCsrfHeaders } from '@/services/api'
import { handleUnauthorized } from '@/services/authSession'

export const useAdminStore = defineStore('admin', () => {
  const token = ref(localStorage.getItem('admin_token') || '')
  const adminUser = ref<{ username?: string; [k: string]: any } | null>(null)

  const isLoggedIn = computed(() => !!token.value)

  async function login(username: string, password: string) {
    const res = await fetch('/api/v1/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `登录失败（${res.status}）`)
    }
    const data = await res.json()
    token.value = data.access_token
    adminUser.value = data.user
    localStorage.setItem('admin_token', token.value)
  }

  async function validateSession(): Promise<boolean | null> {
    if (!token.value) return false
    const res = await authFetch('/api/v1/admin/auth/me')
    if (res.status === 401) {
      token.value = ''
      adminUser.value = null
      handleUnauthorized('admin')
      return false
    }
    if (!res.ok) return null
    adminUser.value = await res.json()
    return true
  }

  function logout() {
    void fetch('/api/v1/admin/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: getCsrfHeaders('gugu_admin_csrf_token'),
    }).catch(() => {})
    token.value = ''
    adminUser.value = null
    localStorage.removeItem('admin_token')
  }

  // 带 Token 的 fetch 封装
  async function authFetch(url: string, options: RequestInit = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...getCsrfHeaders('gugu_admin_csrf_token'),
        ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
        ...(options.headers || {}),
      },
    })
    if (response.status === 401) handleUnauthorized('admin')
    return response
  }

  return { token, adminUser, isLoggedIn, login, logout, validateSession, authFetch }
})
