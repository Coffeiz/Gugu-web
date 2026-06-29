import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAudioStore } from './audio'
import { authApi } from '@/services/api'

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

  function _extractDetail(body, fallback) {
    const d = body?.detail
    if (!d) return fallback
    if (typeof d === 'string') return d
    if (Array.isArray(d)) return d.map(e => e.msg ?? e).join('；')
    return fallback
  }

  async function register(username, email, password, inviteCode) {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, inviteCode }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(_extractDetail(body, '注册失败'))
    _saveToken(body.accessToken)
    _setUser(body.user)
  }

  async function login(username, password) {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(_extractDetail(body, '登录失败'))
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

  async function updateProfile(fields) {
    const updated = await authApi.updateProfile(fields)
    user.value = updated
    return updated
  }

  async function uploadAvatar(file) {
    const updated = await authApi.uploadAvatar(file)
    user.value = updated
    return updated
  }

  function logout() {
    useAudioStore().stop()
    token.value = ''
    user.value  = null
    localStorage.removeItem(TOKEN_KEY)
  }

  return { token, user, isLoggedIn, register, login, fetchMe, updateProfile, uploadAvatar, logout }
})
