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
          <div class="brand-sub">登录你的账号</div>
        </div>
      </div>

      <form @submit.prevent="handleLogin">
        <div class="field">
          <label>用户名</label>
          <input v-model="form.username" type="text" placeholder="输入用户名"
            autocomplete="username" :disabled="loading" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="form.password" type="password" placeholder="••••••••"
            autocomplete="current-password" :disabled="loading" />
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <button type="submit" class="btn-primary" :disabled="loading">
          {{ loading ? '登录中…' : '登录' }}
        </button>
      </form>

      <div class="card-footer">
        没有账号？
        <router-link to="/register">立即注册</router-link>
      </div>
    </div>

    <div class="page-footer">
      <span>Created by Claude with love</span>
      <span class="footer-sep">·</span>
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">苏ICP备2026042185号</a>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router   = useRouter()
const auth     = useAuthStore()
const form     = reactive({ username: '', password: '' })
const loading  = ref(false)
const error    = ref('')

async function handleLogin() {
  if (!form.username || !form.password) { error.value = '请填写用户名和密码'; return }
  loading.value = true; error.value = ''
  try {
    await auth.login(form.username, form.password)
    router.push(router.currentRoute.value.query.redirect ?? '/projects')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
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

.card-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
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

.card-footer {
  margin-top: 22px; text-align: center;
  font-size: 13px; color: #8a8fa8;
}
.card-footer a { color: #7b7fb2; font-weight: 600; text-decoration: none; }
.card-footer a:hover { text-decoration: underline; }

.page-footer {
  position: absolute; bottom: 24px; left: 0; right: 0;
  text-align: center; font-size: 11px; color: rgba(100,108,130,0.55);
  display: flex; align-items: center; justify-content: center; gap: 6px;
  pointer-events: none;
}
.page-footer a {
  color: rgba(100,108,130,0.55); text-decoration: none; pointer-events: auto;
}
.page-footer a:hover { color: rgba(100,108,130,0.85); }
.footer-sep { opacity: 0.5; }
</style>
