<template>
  <div class="auth-page">
    <div class="auth-card">
      <AuthLanguageSwitcher />
      <AuthBrand />
      <div class="verify-content">
        <h1>{{ t('emailChangeUi.verifyTitle') }}</h1>
        <p v-if="loading" class="verify-state">{{ t('emailChangeUi.verifying') }}</p>
        <p v-else-if="success" class="verify-state success">{{ t('emailChangeUi.verified') }}</p>
        <p v-else class="verify-state error">{{ errorMessage }}</p>
        <button v-if="!loading" class="btn-primary" type="button" @click="goLogin">{{ t('emailChangeUi.goLogin') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import AuthBrand from '@/components/common/auth/AuthBrand.vue'
import AuthLanguageSwitcher from '@/components/common/auth/AuthLanguageSwitcher.vue'
import { authApi } from '@/services/api'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const loading = ref(true)
const success = ref(false)
const errorMessage = ref('')

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : ''
  if (!token) {
    errorMessage.value = t('emailChangeUi.verifyFailed')
    loading.value = false
    return
  }
  try {
    await authApi.verifyEmailChange(token)
    success.value = true
  } catch (error) {
    errorMessage.value = (error instanceof Error ? error.message : '') || t('emailChangeUi.verifyFailed')
  } finally {
    loading.value = false
  }
})

function goLogin() { router.push('/login') }
</script>

<style scoped>
.auth-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--bg-gradient, #e4e6ef); font-family: var(--font-sans); }
.auth-card { width: min(380px, 100%); padding: 32px; position: relative; border: 1px solid var(--border-subtle); border-radius: 16px; background: var(--surface-elevated); box-shadow: var(--shadow-lg); }
.auth-card :deep(.language-switcher) { margin-bottom: 18px; }
.verify-content { text-align: center; }
.verify-content h1 { margin: 24px 0 12px; color: var(--content-primary); font-size: 20px; }
.verify-state { min-height: 24px; margin: 0 0 24px; color: var(--content-secondary); }
.verify-state.success { color: var(--status-success); }
.verify-state.error { color: var(--status-danger); }
.btn-primary { width: 100%; }
</style>
