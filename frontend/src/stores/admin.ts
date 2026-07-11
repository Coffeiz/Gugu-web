import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAdminStore = defineStore('admin', () => {
  const token = ref(localStorage.getItem('admin_token') || '')
  const adminUser = ref<{ username?: string; [k: string]: any } | null>(null)

  const isLoggedIn = computed(() => !!token.value)

  async function login(username: string, password: string) {
    const res = await fetch('/api/v1/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  function logout() {
    token.value = ''
    adminUser.value = null
    localStorage.removeItem('admin_token')
  }

  // 带 Token 的 fetch 封装
  async function authFetch(url: string, options: RequestInit = {}) {
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.value}`,
        ...(options.headers || {}),
      },
    })
  }

  return { token, adminUser, isLoggedIn, login, logout, authFetch }
})
