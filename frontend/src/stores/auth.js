import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
const TOKEN_KEY = 'user_token'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
  const user  = ref(null)

  const isLoggedIn = computed(() => !!token.value)

  function _saveToken(t) {
    token.value = t
    localStorage.setItem(TOKEN_KEY, t)
  }

  function _setUser(u) {
    user.value = u
  }

  async function register(username, email, password) {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.detail ?? '注册失败')
    _saveToken(body.accessToken)
    _setUser(body.user)
  }

  async function login(username, password) {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.detail ?? '登录失败')
    _saveToken(body.accessToken)
    _setUser(body.user)
  }

  async function fetchMe() {
    if (!token.value) return
    try {
      const res = await fetch(`${BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token.value}` },
      })
      if (!res.ok) { logout(); return }
      user.value = await res.json()
    } catch {
      logout()
    }
  }

  function logout() {
    token.value = ''
    user.value  = null
    localStorage.removeItem(TOKEN_KEY)
  }

  return { token, user, isLoggedIn, register, login, fetchMe, logout }
})
