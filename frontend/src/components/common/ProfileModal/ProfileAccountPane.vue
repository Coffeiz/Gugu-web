<template>
  <div class="pm-section">
    <div class="pm-section-label">修改密码</div>
    <div class="pm-field"><label>当前密码</label><input v-model="currentPwd" type="password" class="form-input" placeholder="••••••••" /></div>
    <div class="pm-field"><label>新密码</label><input v-model="newPwd" type="password" class="form-input" placeholder="至少 6 位" /></div>
    <div class="pm-field"><label>确认密码</label><input v-model="confirmPwd" type="password" class="form-input" placeholder="再次输入" /></div>
    <div class="pm-footer">
      <span v-if="msg" class="pm-msg" :class="msgType">{{ msg }}</span>
      <button class="pm-save-btn" :disabled="!currentPwd || !newPwd || !confirmPwd || saving" @click="save">
        {{ saving ? '保存中…' : '修改密码' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const currentPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const saving = ref(false)
const msg = ref('')
const msgType = ref('ok')

async function save() {
  msg.value = ''
  if (newPwd.value.length < 6) { msg.value = '新密码至少 6 位'; msgType.value = 'err'; return }
  if (newPwd.value !== confirmPwd.value) { msg.value = '两次密码不一致'; msgType.value = 'err'; return }
  saving.value = true
  try {
    await authStore.updateProfile({ currentPassword: currentPwd.value, newPassword: newPwd.value })
    msg.value = '密码已更新'
    msgType.value = 'ok'
    currentPwd.value = newPwd.value = confirmPwd.value = ''
  } catch (error) {
    msg.value = (error instanceof Error ? error.message : '') || '修改失败'
    msgType.value = 'err'
  } finally {
    saving.value = false
  }
}
</script>
