<template>
  <div class="auth-page">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="auth-card">
      <AuthBrand />

      <template v-if="!sent">
        <p class="hint">{{ t('auth.forgotHint') }}</p>
        <form @submit.prevent="handleSubmit" novalidate>
          <div class="field">
            <label>{{ t('auth.email') }}</label>
            <input v-model="email" type="email" placeholder="your@email.com"
              autocomplete="email" :disabled="loading" />
          </div>

          <div v-if="error" class="error-msg">{{ error }}</div>

          <button type="submit" class="btn-primary" :disabled="loading">
            {{ loading ? t('auth.sendingReset') : t('auth.sendReset') }}
          </button>
        </form>
      </template>

      <template v-else>
        <div class="done-box">
          <div class="done-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7b7fb2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
          </div>
          <p class="done-text">{{ message }}</p>
          <p class="done-sub">{{ t('auth.resetLinkHint') }}</p>
        </div>
      </template>

      <div class="card-footer">
        {{ t('auth.remember') }}
        <router-link to="/login">{{ t('auth.backToLogin') }}</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AuthBrand from '@/components/common/AuthBrand.vue'
import { useI18n } from 'vue-i18n'

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
const email   = ref('')
const loading = ref(false)
const error   = ref('')
const sent    = ref(false)
const message = ref('')
const { t } = useI18n()

async function handleSubmit() {
  if (!email.value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
    error.value = t('auth.validEmail'); return
  }
  loading.value = true; error.value = ''
  try {
    const res = await fetch(`${BASE_URL}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim() }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || t('errors.requestFailed'))
    message.value = body.message || t('auth.resetSent')
    sent.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('auth.operationFailed')
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

.hint { font-size: 13px; color: var(--content-secondary); line-height: 1.6; margin: 0 0 18px; }

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

.done-box { text-align: center; padding: 8px 0 4px; }
.done-icon {
  width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 15px;
  background: rgba(123,127,178,0.1);
  display: flex; align-items: center; justify-content: center;
}
.done-text { font-size: 14px; color: #1e2028; line-height: 1.6; margin: 0 0 8px; }
.done-sub  { font-size: 12px; color: #a0a4b8; line-height: 1.6; margin: 0; }

.card-footer {
  margin-top: 22px; text-align: center;
  font-size: 13px; color: #8a8fa8;
}
.card-footer a { color: #7b7fb2; font-weight: 600; text-decoration: none; }
.card-footer a:hover { text-decoration: underline; }
</style>
