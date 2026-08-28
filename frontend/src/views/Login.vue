<template>
  <div class="auth-page">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="auth-card">
      <AuthBrand />

      <form @submit.prevent="handleLogin">
        <div class="field">
          <label>用户名 / 邮箱</label>
          <input v-model="form.username" type="text" placeholder="输入用户名或邮箱"
            autocomplete="username" :disabled="loading" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="form.password" type="password" placeholder="••••••••"
            autocomplete="current-password" :disabled="loading" />
        </div>

        <div class="forgot-row">
          <router-link to="/forgot-password">忘记密码？</router-link>
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <button type="submit" class="btn-primary" :disabled="loading">
          <span>{{ loading ? '登录中…' : '登录' }}</span>
        </button>
      </form>

      <div class="card-footer">
        没有账号？
        <router-link to="/register">立即注册</router-link>
      </div>
    </div>

    <div class="page-footer">
      <span>Create with agents and love</span>
      <span class="footer-sep">·</span>
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">苏ICP备2026042185号</a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AuthBrand from '@/components/common/AuthBrand.vue'

const router   = useRouter()
const auth     = useAuthStore()
const form     = reactive({ username: '', password: '' })
const loading  = ref(false)
const error    = ref('')

async function handleLogin() {
  if (!form.username || !form.password) { error.value = '请填写用户名/邮箱和密码'; return }
  loading.value = true; error.value = ''
  try {
    await auth.login(form.username, form.password)
    router.push((router.currentRoute.value.query.redirect as string) ?? '/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败'
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
  border-radius: 20px; padding: 28px 32px 32px;
  box-shadow:
    0 20px 60px rgba(80,90,110,0.12),
    inset 0 1px 0 rgba(255,255,255,0.95),
    inset 1px 0 0 rgba(255,255,255,0.55);
}

.field { margin-bottom: 14px; }
.field label {
  display: block; font-size: 11px; font-weight: 600; color: var(--content-secondary);
  text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 7px;
}
.field input {
  width: 100%; padding: 10px 14px;
  background: var(--input-bg); border: 1px solid var(--input-border);
  border-radius: 10px; font-size: 14px; color: var(--input-fg);
  font-family: var(--font-sans); outline: none;
  box-shadow: inset 0 1px 3px rgba(80,90,110,0.06);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.field input:hover:not(:disabled) {
  background: var(--input-bg-hover); border-color: var(--input-border-hover);
}
/* 与 hover 同特异度、源顺序在后：聚焦后悬停不丢 focus 描边。 */
.field input:focus:not(:disabled) {
  border-color: var(--input-border-focus);
  box-shadow: var(--input-focus-shadow), inset 0 1px 3px rgba(80,90,110,0.06);
}
.field input::placeholder { color: var(--input-placeholder); }
.field input:disabled { opacity: 0.5; }

.forgot-row {
  text-align: right; margin: -4px 0 14px;
}
.forgot-row a {
  font-size: 12px; color: var(--content-secondary); text-decoration: none;
}
.forgot-row a:hover { color: var(--action-primary); }

.error-msg {
  font-size: 12px; color: #c05050; margin-bottom: 12px;
  padding: 8px 12px; border-radius: 9px;
  background: rgba(200,80,80,0.08); border: 1px solid rgba(200,80,80,0.15);
}

.btn-primary {
  width: 100%; padding: 11px; margin-top: 4px;
  background: var(--action-primary-bg);
  border: none; border-radius: 11px;
  font-size: 14px; font-weight: 600; color: white;
  cursor: pointer;
  position: relative; isolation: isolate; overflow: hidden;
  transition: box-shadow var(--motion-hover-control) var(--motion-ease-standard),
    opacity var(--motion-hover-control) var(--motion-ease-standard);
  box-shadow: none;
}
.btn-primary::before {
  content: ''; position: absolute; inset: 0; z-index: 0;
  border-radius: inherit; background: var(--action-primary-bg-hover);
  opacity: 0;
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard);
}
.btn-primary > span { position: relative; z-index: 1; }
.btn-primary:hover:not(:disabled) { background: var(--action-primary-bg); opacity: 1; }
.btn-primary:hover:not(:disabled)::before { opacity: 1; }
.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

.card-footer {
  margin-top: 22px; text-align: center;
  font-size: 13px; color: var(--content-secondary);
}
.card-footer a { color: var(--sidebar-item-active-fg); font-weight: 600; text-decoration: none; }
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
