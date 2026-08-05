<template>
  <div class="pm-section">
    <div class="pm-section-label">账号信息</div>
    <div class="pm-field">
      <label>昵称</label>
      <input v-model="displayName" class="form-input" :class="{ modified: displayName !== (authStore.user?.displayName ?? '') }" placeholder="填写昵称" />
    </div>
    <div class="pm-field"><label>用户名</label><div class="pm-static">{{ authStore.user?.username ?? '—' }}</div></div>
    <div class="pm-field"><label>邮箱</label><div class="pm-static">{{ authStore.user?.email ?? '—' }}</div></div>
    <div class="pm-field"><label>UID</label><div class="pm-static pm-uid">{{ authStore.user?.id ?? '—' }}</div></div>
    <div class="pm-field"><label>加入时间</label><div class="pm-static">{{ authStore.user?.createdAt ?? '—' }}</div></div>
    <div class="pm-footer">
      <span v-if="visibleMsg" class="pm-msg" :class="visibleMsgType">{{ visibleMsg }}</span>
      <button class="pm-save-btn" :disabled="displayName === (authStore.user?.displayName ?? '') || saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

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
    msg.value = '保存成功'
    msgType.value = 'ok'
  } catch (error) {
    msg.value = (error instanceof Error ? error.message : '') || '保存失败'
    msgType.value = 'err'
  } finally {
    saving.value = false
  }
}
</script>
