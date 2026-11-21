<template>
  <div class="auth-page admin-login">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="auth-card">
      <AuthBrand />
      <p class="admin-login-subtitle">{{ t('adminExtraUi.adminLogin') }}</p>

      <form @submit.prevent="handleLogin">
        <div class="field">
          <label>{{ t('adminExtraUi.username') }}</label>
          <input v-model="form.username" type="text" placeholder="admin"
            autocomplete="username" :disabled="loading" />
        </div>
        <div class="field">
          <label>{{ t('adminExtraUi.password') }}</label>
          <input v-model="form.password" type="password" placeholder="••••••••"
            autocomplete="current-password" :disabled="loading" />
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <button type="submit" class="btn-primary" :disabled="loading">
          <span v-if="loading">{{ t('adminExtraUi.loggingIn') }}</span>
          <span v-else>{{ t('adminExtraUi.login') }}</span>
        </button>
      </form>

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import AuthBrand from '@/components/common/auth/AuthBrand.vue'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const adminStore = useAdminStore()
const { t } = useI18n()
const form = reactive({ username: '', password: '' })
const loading = ref(false)
const error   = ref('')

async function handleLogin() {
  if (!form.username || !form.password) { error.value = t('adminExtraUi.fillCredentials'); return }
  loading.value = true; error.value = ''
  try {
    await adminStore.login(form.username, form.password)
    router.push('/config')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('adminExtraUi.loginFailed')
  } finally {
    loading.value = false
  }
}
</script>
