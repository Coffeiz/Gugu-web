<template>
  <div class="auth-page">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="auth-card">
      <div class="card-brand">
        <div class="brand-logo-wrap">
          <img class="brand-mark" src="/logo-large2.png" alt="" aria-hidden="true" />
          <img class="brand-wordmark" src="/logo-text2.png" alt="咕咕" />
        </div>
      </div>

      <form @submit.prevent="handleRegister" novalidate>
        <div class="field">
          <label>用户名</label>
          <input v-model="form.username" type="text" placeholder="3-20 个字符"
            autocomplete="username" :disabled="loading" />
        </div>
        <div class="field">
          <label>邮箱</label>
          <input v-model="form.email" type="email" placeholder="your@email.com"
            autocomplete="email" :disabled="loading" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="form.password" type="password" placeholder="至少 8 位"
            autocomplete="new-password" :disabled="loading" />
        </div>
        <Checkbox v-model="acknowledged" class="ack-row">
          <span class="ack-label">测试阶段数据随时可能清空，我已知晓并会自行备份</span>
        </Checkbox>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <button type="submit" class="btn-primary" :disabled="loading || !acknowledged">
          {{ loading ? '注册中…' : '注册' }}
        </button>
      </form>

      <div class="card-footer">
        已有账号？
        <router-link to="/login">立即登录</router-link>
      </div>
      <div class="card-policy">
        注册即表示你已阅读并同意
        <router-link to="/privacy">隐私政策</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import Checkbox from '@/components/common/Checkbox.vue'

const router  = useRouter()
const auth    = useAuthStore()
const form    = reactive({ username: '', email: '', password: '' })
const loading      = ref(false)
const error        = ref('')
const acknowledged = ref(false)

async function handleRegister() {
  if (!form.username || !form.email || !form.password) {
    error.value = '请填写全部信息'; return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    error.value = '邮箱格式不正确'; return
  }
  if (form.password.length < 8) {
    error.value = '密码至少 8 位'; return
  }
  loading.value = true; error.value = ''
  try {
    await auth.register(form.username, form.email, form.password)
    router.push('/')
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

.card-brand {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  margin-bottom: 18px;
}
.brand-logo-wrap {
  width: 244px; height: 82px; position: relative;
  display: flex; align-items: center; justify-content: center; gap: 3px;
}
.brand-logo-wrap::before {
  content: ''; position: absolute; inset: 18% 4%; z-index: 0;
  border-radius: 50%;
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--action-primary) 32%, transparent),
    color-mix(in srgb, var(--action-secondary) 28%, transparent));
  filter: blur(22px); opacity: 0.8;
}
.brand-mark, .brand-wordmark {
  position: relative; z-index: 1; object-fit: contain; display: block;
  filter: var(--brand-logo-filter);
}
.brand-mark { width: 68px; height: 68px; }
.brand-wordmark { width: 158px; height: 80px; }

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
  cursor: pointer; transition: background-color 0.15s;
  box-shadow: none;
}
.btn-primary:hover:not(:disabled) { background: var(--action-primary-bg-hover); opacity: 1; }
.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

.ack-row {
  align-items: center;
  margin-bottom: 12px;
}
.ack-label {
  font-size: 12px; color: var(--content-secondary); line-height: 16px;
}

.card-footer {
  margin-top: 22px; text-align: center;
  font-size: 13px; color: #8a8fa8;
}
.card-footer a { color: #7b7fb2; font-weight: 600; text-decoration: none; }
.card-footer a:hover { text-decoration: underline; }
.card-policy {
  margin-top: 10px; text-align: center;
  font-size: 11px; color: #a0a4b8;
}
.card-policy a { color: #a0a4b8; text-decoration: underline; }
.card-policy a:hover { color: #7b7fb2; }
</style>
