<template>
  <div class="pm-section">
    <div class="pm-section-label">{{ t('sharedUi.info') }}</div>
    <div class="pm-field">
      <label>{{ t('sharedUi.nickname') }}</label>
      <input v-model="displayName" class="form-input" :class="{ modified: displayName !== (authStore.user?.displayName ?? '') }" :placeholder="t('sharedUi.nickname')" />
    </div>
    <div class="pm-field"><label>{{ t('sharedUi.username') }}</label><div class="pm-static">{{ authStore.user?.username ?? '—' }}</div></div>
    <div class="pm-field"><label>{{ t('sharedUi.email') }}</label><div class="pm-static">{{ authStore.user?.email ?? '—' }}</div></div>
    <div class="pm-field"><label>{{ t('sharedUi.uid') }}</label><div class="pm-static pm-uid">{{ authStore.user?.id ?? '—' }}</div></div>
    <div class="pm-field"><label>{{ t('sharedUi.joinedAt') }}</label><div class="pm-static">{{ authStore.user?.createdAt ?? '—' }}</div></div>
    <div class="pm-footer">
      <span v-if="visibleMsg" class="pm-msg" :class="visibleMsgType">{{ visibleMsg }}</span>
      <button class="pm-save-btn" :disabled="displayName === (authStore.user?.displayName ?? '') || saving" @click="save">
        {{ saving ? t('sharedUi.saving') : t('sharedUi.save') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps({
  externalMessage: { type: String, default: '' },
  externalMessageType: { type: String, default: 'ok' },
})
const authStore = useAuthStore()
const displayName = ref(authStore.user?.displayName ?? '')
const saving = ref(false)
const msg = ref('')
const msgType = ref('ok')
const visibleMsg = computed(() => msg.value || props.externalMessage)
const visibleMsgType = computed(() => msg.value ? msgType.value : props.externalMessageType)

watch(() => authStore.user?.displayName, value => { displayName.value = value ?? '' })

async function save() {
  saving.value = true
  msg.value = ''
  try {
    await authStore.updateProfile({ displayName: displayName.value })
    msg.value = t('sharedUi.saveSuccess')
    msgType.value = 'ok'
  } catch (error) {
    msg.value = (error instanceof Error ? error.message : '') || t('sharedUi.saveFailed')
    msgType.value = 'err'
  } finally {
    saving.value = false
  }
}
</script>
