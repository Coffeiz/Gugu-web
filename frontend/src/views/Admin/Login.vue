<template>
  <div class="admin-login">
    <!-- 背景装饰光晕 -->
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="login-card">
      <div class="login-brand">
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
          <h1>咕咕</h1>
          <p>管理后台</p>
        </div>
      </div>

      <form @submit.prevent="handleLogin">
        <div class="field">
          <label>用户名</label>
          <input v-model="form.username" type="text" placeholder="admin"
            autocomplete="username" :disabled="loading" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="form.password" type="password" placeholder="••••••••"
            autocomplete="current-password" :disabled="loading" />
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <button type="submit" class="login-btn" :disabled="loading">
          <span v-if="loading">登录中…</span>
          <span v-else>登录</span>
        </button>
      </form>

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'

const router = useRouter()
const adminStore = useAdminStore()
const form = reactive({ username: '', password: '' })
const loading = ref(false)
const error   = ref('')

async function handleLogin() {
  if (!form.username || !form.password) { error.value = '请填写用户名和密码'; return }
  loading.value = true; error.value = ''
  try {
    await adminStore.login(form.username, form.password)
    router.push('/config')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.admin-login {
  min-height: 100vh;
  background: linear-gradient(150deg, #0f1117 0%, #121626 40%, #161b30 70%, #1a1e38 100%);
  background-attachment: fixed;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-sans);
  position: relative; overflow: hidden;
}

/* 背景光晕 */
.bg-glow {
  position: absolute; border-radius: 50%; pointer-events: none;
  filter: blur(80px);
}
.glow-1 {
  width: 420px; height: 420px;
  top: -100px; left: -80px;
  background: radial-gradient(circle, rgba(123,127,178,0.15) 0%, transparent 65%);
}
.glow-2 {
  width: 320px; height: 320px;
  bottom: -80px; right: -60px;
  background: radial-gradient(circle, rgba(149,144,196,0.1) 0%, transparent 65%);
}

/* 登录卡片 — 暗玻璃 */
.login-card {
  width: 360px; position: relative; z-index: 1;
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 20px;
  padding: 36px 32px;
  box-shadow:
    0 24px 64px rgba(0,0,0,0.5),
    0 1px 0 rgba(255,255,255,0.07) inset,
    1px 0 0 rgba(255,255,255,0.04) inset;
}

.login-brand {
  display: flex; align-items: center; gap: 13px; margin-bottom: 32px;
}
.brand-icon {
  width: 44px; height: 44px; border-radius: 13px;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 6px 18px rgba(123,127,178,0.45);
}
.login-brand h1 { font-size: 18px; font-weight: 700; color: rgba(255,255,255,0.92); }
.login-brand p  { font-size: 12px; color: rgba(255,255,255,0.3); margin-top: 3px; }

.field { margin-bottom: 14px; }
.field label {
  display: block; font-size: 11px; font-weight: 600;
  color: rgba(255,255,255,0.3); text-transform: uppercase;
  letter-spacing: 0.07em; margin-bottom: 7px;
}
.field input {
  width: 100%; padding: 10px 14px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px; font-size: 14px;
  color: rgba(255,255,255,0.88);
  font-family: var(--font-sans);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}
.field input:focus {
  border-color: rgba(149,144,196,0.55);
  box-shadow: 0 0 0 3px rgba(149,144,196,0.12);
  background: rgba(255,255,255,0.08);
}
.field input::placeholder { color: rgba(255,255,255,0.2); }
.field input:disabled { opacity: 0.45; }

.error-msg {
  font-size: 12px; color: #e07878; margin-bottom: 12px;
  padding: 8px 12px; border-radius: 9px;
  background: rgba(220,80,80,0.1); border: 1px solid rgba(220,80,80,0.2);
}

.login-btn {
  width: 100%; padding: 11px; margin-top: 6px;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border: none; border-radius: 11px;
  font-size: 14px; font-weight: 600; color: white;
  cursor: pointer; transition: opacity 0.15s, transform 0.15s;
  box-shadow: 0 4px 18px rgba(123,127,178,0.4);
}
.login-btn:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
.login-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.login-footer { margin-top: 24px; text-align: center; }
.login-footer a {
  font-size: 12px; color: rgba(255,255,255,0.25);
  text-decoration: none; transition: color 0.15s;
}
.login-footer a:hover { color: rgba(255,255,255,0.55); }
</style>
