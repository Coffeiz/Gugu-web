<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, ref } from 'vue'
import { mailPresets, type MailAccountSummary, type MailOAuthProvider } from '@gugu/email/contracts'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import MailProviderIcon from './MailProviderIcon.vue'
import { mailProviderForAccount, mailProviders, type MailProvider } from './providers'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { useMailAccess } from '@/api/mail'
import { errorMessage } from '@/composables/core/useAppToast'

const { t } = useI18n()

const { request: requestMail, oauth } = useMailAccess()
const props = defineProps<{ account?: MailAccountSummary }>()
const emit = defineEmits<{ saved: [account: MailAccountSummary]; cancel: [] }>()
const oauthProviders = ref<MailOAuthProvider[]>([])
const provider = ref<MailProvider | null>(
  props.account ? mailProviderForAccount(props.account).id : null,
)
const selectedProvider = computed(() => mailProviders.find(option => option.id === provider.value))
// 桌面新接入 Gmail 使用 Google 授权，重新连接时沿用账号已保存的认证方式。
const oauthProvider = computed(() => props.account?.oauthProvider
  ?? (!props.account && oauth && provider.value === 'gmail' ? 'gmail' : null))
const loadingOAuthProviders = ref(Boolean(oauth && !oauth.preview && (!props.account || props.account.oauthProvider)))
const oauthAvailable = computed(() => oauthProvider.value !== null && oauthProviders.value.includes(oauthProvider.value))
const oauthHint = computed(() => {
  if (oauth?.preview) return t('pageUi.desktopConnectMail')
  if (loadingOAuthProviders.value) return t('pageUi.checkingAuthorization')
  if (!oauthAvailable.value) return t('pageUi.oauthUnavailable')
  return t('pageUi.oauthBrowserHint')
})
const serverOpen = ref(provider.value === 'other')
const separateSmtp = ref(Boolean(props.account?.smtpUsername))
const form = reactive({
  displayName: props.account?.displayName ?? '', senderName: props.account?.senderName ?? '',
  receiveOnly: props.account?.receiveOnly ?? false, smtpUsername: props.account?.smtpUsername ?? '', smtpPassword: '',
  email: props.account?.email ?? '', username: props.account?.username ?? '', password: '',
  imapHost: props.account?.imapHost ?? '', smtpHost: props.account?.smtpHost ?? '',
  smtpPort: props.account?.smtpPort ?? 465 as 465 | 587,
})
const busy = ref(false)
const error = ref('')
onMounted(async () => {
  if (!loadingOAuthProviders.value || !oauth) return
  try { oauthProviders.value = await oauth.providers() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { loadingOAuthProviders.value = false }
})
function chooseProvider(id: MailProvider) {
  provider.value = id
  serverOpen.value = id === 'other'
  Object.assign(form, id === 'other' ? { imapHost: '', smtpHost: '', smtpPort: 465 } : mailPresets[id])
}

function changeProvider() {
  provider.value = null
  error.value = ''
  form.password = ''
  form.smtpPassword = ''
}

async function save() {
  if (busy.value || !provider.value) return
  if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    error.value = t('pageUi.validEmail')
    return
  }
  if (oauthProvider.value) {
    if (!oauth || !oauthAvailable.value) return
    busy.value = true
    error.value = ''
    try { emit('saved', await oauth.connect(oauthProvider.value, form.email.trim(), props.account?.id)) }
    catch (cause) { error.value = errorMessage(cause) }
    finally { busy.value = false }
    return
  }
  if (!props.account && !form.password) {
    error.value = t('pageUi.enterAppPassword')
    return
  }
  if (!form.imapHost.trim() || (!form.receiveOnly && !form.smtpHost.trim())
    || (!form.receiveOnly && separateSmtp.value && (!form.smtpUsername.trim() || (!props.account?.smtpUsername && !form.smtpPassword)))) {
    serverOpen.value = true
    error.value = t('pageUi.completeServerSettings')
    return
  }
  busy.value = true
  error.value = ''
  try {
    const account = await requestMail<MailAccountSummary>({
      action: 'connect', accountId: props.account?.id,
      account: {
        ...form, email: form.email.trim(), username: form.username.trim() || form.email.trim(),
        smtpHost: form.receiveOnly ? '' : form.smtpHost,
        smtpUsername: separateSmtp.value && !form.receiveOnly ? form.smtpUsername.trim() : undefined,
        smtpPassword: separateSmtp.value && !form.receiveOnly ? form.smtpPassword || undefined : undefined,
      },
    })
    form.password = ''
    form.smtpPassword = ''
    emit('saved', account)
  } catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <BaseModal :show="true" width="min(480px, calc(100vw - 32px))" background="var(--modal-card-bg)" teleport-to="body" @close="!busy && emit('cancel')">
  <section v-if="!selectedProvider" class="mail-account-form" :aria-label="$t('pageUi.chooseProvider')">
    <h2>{{ $t('pageUi.addMailbox') }}</h2>
    <p class="mail-form-hint">{{ $t('pageUi.chooseProvider') }}</p>
    <div class="mail-provider-options">
      <button v-for="option in mailProviders" :key="option.id" type="button" class="mail-provider-option" @click="chooseProvider(option.id)">
        <MailProviderIcon :src="option.icon" />
        <span>{{ option.label }}</span>
        <FlipChevron aria-hidden="true" />
      </button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="mail-form-actions app-card-actions">
      <ActionButton fit variant="secondary" type="button" @click="emit('cancel')">{{ $t('common.actions.cancel') }}</ActionButton>
    </div>
  </section>
  <form v-else class="mail-account-form" novalidate @submit.prevent="save">
    <h2>{{ account ? $t('pageUi.reconnectMail') : $t('pageUi.addMailbox') }}</h2>
    <div class="mail-selected-provider">
      <MailProviderIcon :src="selectedProvider.icon" />
      <strong>{{ selectedProvider.label }}</strong>
      <ActionButton v-if="!account" fit variant="secondary" type="button" :disabled="busy" @click="changeProvider">{{ $t('pageUi.replace') }}</ActionButton>
    </div>
    <template v-if="oauthProvider">
      <span>{{ $t('pageUi.emailAddress') }}</span>
      <input v-model="form.email" type="email" class="form-input" :aria-label="$t('pageUi.emailAddress')" required :readonly="!!account" />
      <p class="mail-form-hint">{{ oauthHint }}</p>
    </template>
    <template v-else>
    <span>{{ $t('pageUi.emailAddress') }}</span>
    <input v-model="form.email" type="email" class="form-input" :aria-label="$t('pageUi.emailAddress')" required />
    <span>{{ $t('pageUi.appPasswordHint') }}</span>
    <input v-model="form.password" type="password" class="form-input" :aria-label="$t('pageUi.emailPassword')" autocomplete="new-password" :placeholder="account ? $t('pageUi.keepPassword') : ''" />
    <p v-if="provider === 'gmail'" class="mail-form-hint">{{ $t('pageUi.googlePasswordHint') }}</p>
    <p v-if="provider === 'outlook'" class="mail-form-hint">{{ $t('pageUi.imapSmtpHint') }}</p>
    <span>{{ $t('pageUi.optionalAccount') }}</span>
    <input v-model="form.displayName" class="form-input" :aria-label="$t('pageUi.accountName')" maxlength="80" :placeholder="$t('pageUi.exampleAccount')" />
    <div class="mail-server-settings">
      <button type="button" class="mail-disclosure" :aria-expanded="serverOpen" aria-controls="mail-server-fields"
        @click="serverOpen = !serverOpen">
        <FlipChevron :open="serverOpen" aria-hidden="true" />
        {{ $t('pageUi.serverSettings') }}
      </button>
      <div v-show="serverOpen" id="mail-server-fields" class="mail-server-fields">
        <span>{{ $t('pageUi.loginUsername') }}</span>
        <input v-model="form.username" class="form-input" :aria-label="$t('pageUi.loginUsername')" :placeholder="$t('pageUi.defaultEmail')" />
        <span>{{ $t('pageUi.incomingServer') }}</span>
        <input v-model="form.imapHost" class="form-input" :aria-label="$t('pageUi.imapServer')" />
        <label class="mail-checkbox"><input v-model="form.receiveOnly" type="checkbox" />{{ $t('pageUi.receiveOnlyMail') }}</label>
        <template v-if="!form.receiveOnly">
          <span>{{ $t('pageUi.outgoingServer') }}</span>
          <input v-model="form.smtpHost" class="form-input" :aria-label="$t('pageUi.smtpServer')" />
          <SelectPopup :model-value="String(form.smtpPort)" :options="[{ value: '465', label: '465 · TLS' }, { value: '587', label: '587 · STARTTLS' }]"
            :aria-label="$t('pageUi.smtpPort')" @update:model-value="form.smtpPort = $event === '587' ? 587 : 465" />
          <span>{{ $t('pageUi.optionalSender') }}</span>
          <input v-model="form.senderName" class="form-input" :aria-label="$t('pageUi.senderName')" maxlength="80" />
          <label class="mail-checkbox"><input v-model="separateSmtp" type="checkbox" />{{ $t('pageUi.separateCredentials') }}</label>
          <template v-if="separateSmtp">
            <span>{{ $t('pageUi.smtpUsername') }}</span>
            <input v-model="form.smtpUsername" class="form-input" :aria-label="$t('pageUi.smtpUsername')" />
            <span>{{ $t('pageUi.smtpPassword') }}</span>
            <input v-model="form.smtpPassword" type="password" class="form-input" :aria-label="$t('pageUi.smtpPassword')" autocomplete="new-password" :placeholder="account?.smtpUsername ? $t('pageUi.keepPassword') : ''" />
          </template>
        </template>
      </div>
    </div>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="mail-form-actions app-card-actions">
      <ActionButton fit variant="secondary" type="button" :disabled="busy" @click="emit('cancel')">{{ $t('common.actions.cancel') }}</ActionButton>
      <ActionButton fit type="submit" :disabled="busy || (oauthProvider !== null && !oauthAvailable)">{{ oauthProvider ? (busy ? $t('pageUi.awaitAuthorization') : oauthProvider === 'gmail' ? $t('pageUi.googleAuthorization') : $t('pageUi.browserAuthorization')) : (busy ? $t('pageUi.verifying') : account ? $t('pageUi.testReconnect') : $t('pageUi.testAdd')) }}</ActionButton>
    </div>
  </form>
  </BaseModal>
</template>

<style scoped>
.mail-account-form { display: grid; gap: var(--space-sm); max-height: min(80vh, 720px); overflow: auto; --card-actions-inset: var(--space-lg); padding: var(--space-lg) var(--card-actions-inset) 0; }
.mail-account-form h2 { margin: 0; font-size: var(--font-size-lg); }
.mail-server-fields { display: grid; gap: var(--space-sm); margin-top: var(--space-sm); }
.mail-checkbox { display: flex; align-items: center; gap: var(--space-xs); }
.mail-form-hint { margin: 0; color: var(--content-secondary); }
.mail-form-hint, .mail-checkbox { font-size: var(--font-size-sm); }
form.mail-account-form > span,
.mail-server-fields > span {
  color: var(--content-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-ui);
}
.mail-account-form [role="alert"] { margin: 0; color: var(--status-danger); }
.mail-provider-options { display: grid; gap: var(--option-gap); }
.mail-selected-provider, .mail-provider-option, .mail-disclosure {
  display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm);
  border: 1px solid var(--border-hairline); border-radius: var(--radius-xs);
  background: var(--surface-soft); color: var(--content-primary); font: inherit; text-align: left;
}
.mail-provider-option, .mail-disclosure { cursor: pointer; }
.mail-provider-option:hover, .mail-disclosure:hover { background: var(--option-bg-hover); }
.mail-provider-option span, .mail-selected-provider strong { flex: 1; min-width: 0; }
.mail-disclosure { width: 100%; color: var(--content-secondary); }
.mail-server-settings { min-width: 0; }
.mail-provider-option:focus-visible, .mail-disclosure:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.mail-form-actions { display: flex; justify-content: flex-end; gap: var(--space-sm); }
</style>
