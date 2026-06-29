<template>
  <div class="auth-page">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="auth-card">
      <div class="card-brand">
        <div class="brand-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 7h.01"/>
            <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>
            <path d="M20 7l2 .5-2 .5"/>
            <path d="M10 18v3"/>
            <path d="M14 17.75V21"/>
            <path d="M7 18a6 6 0 0 0 3.84-10.61"/>
          </svg>
        </div>
        <div>
          <div class="brand-name">咕咕</div>
          <div class="brand-sub">设置新密码</div>
        </div>
      </div>

      <template v-if="done">
        <div class="done-box">
          <div class="done-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#7b7fb2" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
          </div>
          <p class="done-text">密码已重置，请用新密码登录。</p>
        </div>
        <button class="btn-primary" @click="goLogin">前往登录</button>
      </template>

      <template v-else-if="!token">
        <div class="error-msg">链接无效或缺少参数，请重新申请重置邮件。</div>
        <div class="card-footer" style="margin-top:14px">
          <router-link to="/forgot-password">重新申请</router-link>
        </div>
      </template>

      <template v-else>
        <form @submit.prevent="handleSubmit" novalidate>
          <div class="field">
            <label>新密码</label>
            <input v-model="pw" type="password" placeholder="至少 8 位"
              autocomplete="new-password" :disabled="loading" />
          </div>
          <div class="field">
            <label>确认新密码</label>
            <input v-model="pw2" type="password" placeholder="再输入一次"
              autocomplete="new-password" :disabled="loading" />
          </div>

          <div v-if="error" class="error-msg">{{ error }}</div>

          <button type="submit" class="btn-primary" :disabled="loading">
            {{ loading ? '提交中…' : '重置密码' }}
          </button>
        </form>

        <div class="card-footer">
          <router-link to="/login">返回登录</router-link>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
const route   = useRoute()
const router  = useRouter()
const token   = ref(route.query.token || '')
const pw      = ref('')
const pw2     = ref('')
const loading = ref(false)
const error   = ref('')
const done    = ref(false)

async function handleSubmit() {
  if (pw.value.length < 8) { error.value = '密码至少 8 位'; return }
  if (pw.value !== pw2.value) { error.value = '两次输入的密码不一致'; return }
  loading.value = true; error.value = ''
  try {
    const res = await fetch(`${BASE_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.value, newPassword: pw.value }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || '重置失败，请重试')
    done.value = true
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function goLogin() { router.push('/login') }
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  background: var(--bg-gradient, linear-gradient(160deg, #e8e9ee 0%, #d8dae4 35%, #bfc4d2 65%, #9aa2b8 100%));
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-sans); position: relative; overflow: hidden;
}

.bg-glow {
  position: absolute; border-radius: 50%; pointer-events: none; filter: blur(80px);
}
.glow-1 {
  width: 500px; height: 500px; top: -120px; left: -100px;
  background: radial-gradient(circle, rgba(123,127,178,0.18) 0%, transparent 65%);
}
.glow-2 {
  width: 380px; height: 380px; bottom: -100px; right: -80px;
  background: radial-gradient(circle, rgba(196,175,200,0.14) 0%, transparent 65%);
}

.auth-card {
  width: 380px; position: relative; z-index: 1;
  background: rgba(255,255,255,0.56);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.76);
  border-radius: 20px; padding: 36px 32px;
  box-shadow:
    0 20px 60px rgba(80,90,110,0.12),
    inset 0 1px 0 rgba(255,255,255,0.95),
    inset 1px 0 0 rgba(255,255,255,0.55);
}

.card-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
.brand-icon {
  width: 44px; height: 44px; border-radius: 13px; flex-shrink: 0;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 18px rgba(123,127,178,0.35);
}
.brand-name { font-size: 18px; font-weight: 700; color: #1e2028; }
.brand-sub  { font-size: 12px; color: #8a8fa8; margin-top: 2px; }

.field { margin-bottom: 14px; }
.field label {
  display: block; font-size: 11px; font-weight: 600; color: #8a8fa8;
  text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 7px;
}
.field input {
  width: 100%; padding: 10px 14px;
  background: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.76);
  border-radius: 10px; font-size: 14px; color: #1e2028;
  font-family: var(--font-sans); outline: none;
  box-shadow: inset 0 1px 3px rgba(80,90,110,0.06);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.field input:focus {
  border-color: rgba(123,127,178,0.5);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.12), inset 0 1px 3px rgba(80,90,110,0.06);
}
.field input::placeholder { color: #b0b4c4; }
.field input:disabled { opacity: 0.5; }

.error-msg {
  font-size: 12px; color: #c05050; margin-bottom: 12px;
  padding: 8px 12px; border-radius: 9px;
  background: rgba(200,80,80,0.08); border: 1px solid rgba(200,80,80,0.15);
}

.btn-primary {
  width: 100%; padding: 11px; margin-top: 4px;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border: none; border-radius: 11px;
  font-size: 14px; font-weight: 600; color: white;
  cursor: pointer; transition: opacity 0.15s, transform 0.15s;
  box-shadow: 0 4px 16px rgba(123,127,178,0.32);
}
.btn-primary:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

.done-box { text-align: center; padding: 8px 0 18px; }
.done-icon {
  width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 15px;
  background: rgba(123,127,178,0.1);
  display: flex; align-items: center; justify-content: center;
}
.done-text { font-size: 14px; color: #1e2028; line-height: 1.6; margin: 0; }

.card-footer {
  margin-top: 22px; text-align: center;
  font-size: 13px; color: #8a8fa8;
}
.card-footer a { color: #7b7fb2; font-weight: 600; text-decoration: none; }
.card-footer a:hover { text-decoration: underline; }
</style>
