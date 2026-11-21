<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { mailPresets, type MailAccountSummary } from '@gugu/core/mail/contracts'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { useMailAccess } from '@/api/mail'
import { errorMessage } from '@/composables/core/useAppToast'

const { request: requestMail } = useMailAccess()
const props = defineProps<{ account?: MailAccountSummary }>()
const emit = defineEmits<{ saved: [account: MailAccountSummary]; cancel: [] }>()
const preset = ref('')
const options = [
  { value: 'qq', label: 'QQ 邮箱' }, { value: '163', label: '网易 163 邮箱' },
  { value: '126', label: '网易 126 邮箱' }, { value: 'yeah', label: '网易 Yeah 邮箱' },
  { value: 'icloud', label: 'iCloud 邮箱' }, { value: '', label: '其他邮箱' },
]
const form = reactive({
  email: props.account?.email ?? '', username: props.account?.username ?? '', password: '',
  imapHost: props.account?.imapHost ?? '', smtpHost: props.account?.smtpHost ?? '',
  smtpPort: props.account?.smtpPort ?? 465 as 465 | 587,
})
const busy = ref(false)
const error = ref('')
watch(preset, value => {
  if (value && Object.hasOwn(mailPresets, value)) Object.assign(form, mailPresets[value as keyof typeof mailPresets])
})

async function save() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const account = await requestMail<MailAccountSummary>({
      action: 'connect', accountId: props.account?.id,
      account: { ...form, email: form.email.trim(), username: form.username.trim() || form.email.trim() },
    })
    form.password = ''
    emit('saved', account)
  } catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <form class="mail-account-form" @submit.prevent="save">
    <h2>{{ account ? '重新连接邮箱' : '添加邮箱' }}</h2>
    <SelectPopup v-model="preset" :options="options" aria-label="邮箱服务商" />
    <span>邮箱地址</span>
    <input v-model="form.email" type="email" class="form-input" aria-label="邮箱地址" required />
    <span>登录用户名</span>
    <input v-model="form.username" class="form-input" aria-label="登录用户名" placeholder="默认使用邮箱地址" />
    <span>客户端授权码或 App 专用密码</span>
    <input v-model="form.password" type="password" class="form-input" aria-label="邮箱授权码" autocomplete="new-password" required />
    <span>IMAP 服务器（TLS 993）</span>
    <input v-model="form.imapHost" class="form-input" aria-label="IMAP 服务器" required />
    <span>SMTP 服务器</span>
    <input v-model="form.smtpHost" class="form-input" aria-label="SMTP 服务器" required />
    <SelectPopup :model-value="String(form.smtpPort)" :options="[{ value: '465', label: '465 · TLS' }, { value: '587', label: '587 · STARTTLS' }]"
      aria-label="SMTP 端口" @update:model-value="form.smtpPort = $event === '587' ? 587 : 465" />
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="mail-form-actions">
      <ActionButton fit variant="secondary" type="button" :disabled="busy" @click="emit('cancel')">取消</ActionButton>
      <ActionButton fit type="submit" :disabled="busy">{{ busy ? '正在验证' : '验证并连接' }}</ActionButton>
    </div>
  </form>
</template>

<style scoped>
.mail-account-form { display: grid; gap: var(--space-sm); max-width: 460px; padding: var(--space-lg); }
.mail-account-form h2 { margin: 0; font-size: var(--font-size-lg); }
.mail-form-actions { display: flex; justify-content: flex-end; gap: var(--space-sm); }
</style>
