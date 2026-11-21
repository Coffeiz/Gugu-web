import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getCsrfHeaders } from '@/services/api'
import { handleUnauthorized } from '@/services/authSession'

export const useAdminStore = defineStore('admin', () => {
  const adminUser = ref<{ username?: string; [k: string]: any } | null>(null)

  const isLoggedIn = computed(() => !!adminUser.value)

  async function login(username: string, password: string) {
    const res = await fetch('/api/v1/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Transport': 'cookie' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `登录失败（${res.status}）`)
    }
    const data = await res.json()
    adminUser.value = data.user
  }

  async function validateSession(): Promise<boolean | null> {
    const res = await authFetch('/api/v1/admin/auth/me')
    if (res.status === 401) {
      adminUser.value = null
      handleUnauthorized('admin')
      return false
    }
    if (!res.ok) return null
    adminUser.value = await res.json()
    return true
  }

  async function logout(): Promise<boolean> {
    let response: Response
    try {
      response = await fetch('/api/v1/admin/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: getCsrfHeaders('gugu_admin_csrf_token'),
        keepalive: true,
      })
    } catch {
      return false
    }
    if (!response.ok && response.status !== 401) return false
    adminUser.value = null
    return true
  }

  // 带 HttpOnly Cookie 与 CSRF 的 fetch 封装
  async function authFetch(url: string, options: RequestInit = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...getCsrfHeaders('gugu_admin_csrf_token'),
        ...(options.headers || {}),
      },
    })
    if (response.status === 401) handleUnauthorized('admin')
    return response
  }

  return { adminUser, isLoggedIn, login, logout, validateSession, authFetch }
})
