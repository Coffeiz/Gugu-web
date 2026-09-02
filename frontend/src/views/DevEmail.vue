<template>
  <main class="email-lab glass-card">
    <section class="lab-layout">
      <aside class="lab-controls glass-card">
        <div class="control-section">
          <span class="section-label">{{ t('devEmail.template') }}</span>
          <button v-for="item in templates" :key="item.value" class="choice-row" :class="{ active: template === item.value }" @click="template = item.value">
            <span><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></span><span class="choice-dot" />
          </button>
        </div>
        <div class="control-section">
          <span class="section-label">{{ t('devEmail.theme') }}</span>
          <div class="choice-pills"><button v-for="item in themes" :key="item.value" :class="{ active: theme === item.value }" @click="theme = item.value">{{ item.label }}</button></div>
        </div>
        <div class="control-section">
          <span class="section-label">{{ t('devEmail.palette') }}</span>
          <div class="palette-grid"><button v-for="item in palettes" :key="item.value" :class="['palette', `palette-${item.value}`, { active: palette === item.value }]" :aria-label="item.label" @click="palette = item.value"><span />{{ item.label }}</button></div>
        </div>
        <div class="control-section smtp-state">
          <span class="section-label">{{ t('devEmail.sendTest') }}</span>
          <p v-if="smtpLoading">{{ t('devEmail.loadingSmtp') }}</p>
          <p v-else-if="smtpConfigured" class="state-ok"><span class="state-dot" />{{ t('devEmail.smtpReady') }}</p>
          <p v-else class="state-muted"><span class="state-dot" />{{ t('devEmail.smtpMissing') }}</p>
          <label class="recipient-field"><span>{{ t('devEmail.recipient') }}</span><input v-model="testRecipient" type="email" :placeholder="t('devEmail.recipientPlaceholder')" autocomplete="email" /></label>
          <ActionButton class="send-button" :disabled="sending || !smtpConfigured" @click="sendTest">{{ sending ? t('devEmail.sending') : t('devEmail.sendCurrent') }}</ActionButton>
          <p v-if="message" class="result" :class="{ error: failed }" role="status">{{ message }}</p>
        </div>
      </aside>

      <section class="preview-wrap">
        <div class="preview-toolbar"><span>{{ t('devEmail.livePreview') }}</span><div class="preview-toolbar-actions"><code>{{ template }} · {{ theme }} · {{ palette }}</code><ActionButton variant="secondary" fit :disabled="previewLoading" @click="loadPreview">{{ previewLoading ? t('devEmail.refreshingPreview') : t('devEmail.refreshPreview') }}</ActionButton></div></div>
        <iframe v-if="previewHtml" ref="previewFrame" class="email-preview-frame" :class="{ 'is-dark': theme === 'dark' }" :srcdoc="previewHtml" title="Email preview" @load="resizePreview" />
        <div v-else class="email-preview-loading">{{ t('devEmail.loadingPreview') }}</div>
      </section>
    </section>
  </main>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { preferencesApi } from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import ActionButton from '@/components/common/controls/ActionButton.vue'

type TemplateName = 'notification' | 'reminder' | 'report' | 'security' | 'test'
type EmailTheme = 'light' | 'dark'
const { t } = useI18n()
const authStore = useAuthStore()
const template = ref<TemplateName>('notification')
const theme = ref<EmailTheme>('light')
const palette = ref('mist')
const smtpConfig = ref<Record<string, unknown> | null>(null)
const smtpConfigured = ref(false)
const smtpLoading = ref(true)
const testRecipient = ref('')
const sending = ref(false)
const message = ref('')
const failed = ref(false)
const previewHtml = ref('')
const previewFrame = ref<HTMLIFrameElement | null>(null)
const previewLoading = ref(false)

const templates = [
  { value: 'notification' as TemplateName, label: t('devEmail.templates.notification.label'), hint: t('devEmail.templates.notification.hint'), eyebrow: 'NOTIFICATION', title: t('devEmail.templates.notification.title'), section: t('devEmail.templates.notification.section'), body: t('devEmail.templates.notification.body') },
  { value: 'reminder' as TemplateName, label: t('devEmail.templates.reminder.label'), hint: t('devEmail.templates.reminder.hint'), eyebrow: 'REMINDER', title: t('devEmail.templates.reminder.title'), section: t('devEmail.templates.reminder.section'), body: t('devEmail.templates.reminder.body') },
  { value: 'report' as TemplateName, label: t('devEmail.templates.report.label'), hint: t('devEmail.templates.report.hint'), eyebrow: 'REPORT', title: t('devEmail.templates.report.title'), section: t('devEmail.templates.report.section'), body: t('devEmail.templates.report.body') },
  { value: 'security' as TemplateName, label: t('devEmail.templates.security.label'), hint: t('devEmail.templates.security.hint'), eyebrow: 'SECURITY', title: t('devEmail.templates.security.title'), section: t('devEmail.templates.security.section'), body: t('devEmail.templates.security.body') },
  { value: 'test' as TemplateName, label: t('devEmail.templates.test.label'), hint: t('devEmail.templates.test.hint'), eyebrow: 'TEST', title: t('devEmail.templates.test.title'), section: t('devEmail.templates.test.section'), body: t('devEmail.templates.test.body') },
]
const themes: Array<{ value: EmailTheme; label: string }> = [{ value: 'light', label: t('devEmail.light') }, { value: 'dark', label: t('devEmail.dark') }]
const palettes = [{ value: 'mist', label: t('devEmail.palettes.mist') }, { value: 'cafe', label: t('devEmail.palettes.cafe') }, { value: 'rose', label: t('devEmail.palettes.rose') }, { value: 'sky', label: t('devEmail.palettes.sky') }, { value: 'sage', label: t('devEmail.palettes.sage') }]
async function loadPreview() {
  previewLoading.value = true
  try {
    const result = await preferencesApi.previewEmail({ template: template.value, theme: theme.value, palette: palette.value })
    previewHtml.value = result.html
    await nextTick()
    resizePreview()
  } catch {
    previewHtml.value = ''
  } finally {
    previewLoading.value = false
  }
}

function resizePreview() {
  const frame = previewFrame.value
  const document = frame?.contentDocument
  if (!frame || !document) return
  const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  frame.style.height = `${height + 2}px`
}

async function loadSmtp() {
  smtpLoading.value = true
  try { const config = await preferencesApi.getSmtp(); smtpConfig.value = config; smtpConfigured.value = !!config?.configured && !!config.enabled } catch { smtpConfig.value = null; smtpConfigured.value = false } finally { smtpLoading.value = false }
}
async function sendTest() {
  sending.value = true; message.value = ''; failed.value = false
  try {
    const result = await preferencesApi.testSmtp({
      host: smtpConfig.value?.host,
      port: smtpConfig.value?.port,
      user: smtpConfig.value?.user,
      fromAddr: smtpConfig.value?.fromAddr,
      useSsl: smtpConfig.value?.useSsl,
      toAddr: testRecipient.value.trim() || undefined,
      template: template.value, theme: theme.value, palette: palette.value,
    })
    message.value = result.message
    failed.value = !result.ok
  } catch { message.value = t('devEmail.sendFailed'); failed.value = true } finally { sending.value = false }
}
onMounted(async () => {
  if (!authStore.user) await authStore.fetchMe()
  if (authStore.user?.email) testRecipient.value = authStore.user.email
  await Promise.all([loadSmtp(), loadPreview()])
})
watch([template, theme, palette], loadPreview)
</script>

<style scoped>
.email-lab { --glass-card-background: var(--column-bg); --glass-card-background-hover: var(--column-bg); --glass-card-border: var(--border-default); --glass-card-border-hover: var(--border-default); --glass-card-shadow: var(--elevation-card); --glass-card-shadow-hover: var(--elevation-card-hover); width:100%; min-height:100%; margin:0; padding:22px 24px; box-sizing:border-box; overflow:auto; color:var(--content-primary); scrollbar-width:thin; scrollbar-color:var(--border-default) var(--surface-raised); }
:global(html[data-theme='dark']) .email-lab::-webkit-scrollbar { width:10px; height:10px; }
:global(html[data-theme='dark']) .email-lab::-webkit-scrollbar-track { background:var(--surface-raised); }
:global(html[data-theme='dark']) .email-lab::-webkit-scrollbar-thumb { background:var(--border-default); border-radius:5px; }
.section-label { color:var(--content-tertiary); font-size:11px; font-weight:700; letter-spacing:.12em; }
.lab-layout { display:grid; grid-template-columns:300px minmax(0,1fr); gap:18px; margin-top:22px; }.lab-controls { padding:18px; background:var(--surface-glass); border:1px solid var(--border-default); border-radius:var(--radius-md); }.control-section { padding-bottom:18px; margin-bottom:18px; border-bottom:1px solid var(--border-subtle); }.control-section:last-child { padding-bottom:0; margin-bottom:0; border-bottom:0; }.section-label { display:block; margin-bottom:10px; letter-spacing:.04em; }
.choice-row { width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px; border:1px solid transparent; border-radius:var(--radius-sm); color:var(--content-primary); background:transparent; text-align:left; cursor:pointer; transition:background .16s ease,border-color .16s ease; }.choice-row:hover { background:var(--surface-raised); }.choice-row.active { border-color:var(--action-outline); background:var(--action-soft); }.choice-row strong,.choice-row small { display:block; }.choice-row strong { font-size:13px; }.choice-row small { margin-top:3px; color:var(--content-tertiary); font-size:11px; }.choice-dot,.state-dot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--content-tertiary); }.active .choice-dot,.state-ok .state-dot { background:var(--status-success); }.choice-pills { display:flex; gap:7px; }.choice-pills button,.palette { border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--surface-raised); color:var(--content-secondary); padding:7px 12px; cursor:pointer; }.choice-pills button.active { border-color:var(--action-outline); color:var(--action-primary); background:var(--action-soft); }.palette-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; }.palette { padding:7px 3px 5px; font-size:10px; }.palette span { display:block; width:18px; height:18px; margin:0 auto 4px; border-radius:50%; background:var(--swatch); }.palette.active { outline:2px solid var(--action-primary); outline-offset:1px; }.palette-mist { --swatch:#898cc0; }.palette-cafe { --swatch:#a77e63; }.palette-rose { --swatch:#c887a6; }.palette-sky { --swatch:#72a6c2; }.palette-sage { --swatch:#83a58b; }
.smtp-state p { margin:0 0 12px; color:var(--content-secondary); font-size:11px; line-height:1.5; }.state-ok,.state-muted { display:flex; gap:7px; align-items:flex-start; }.state-ok .state-dot { margin-top:5px; }.recipient-field { display:block; margin:0 0 12px; }.recipient-field span { display:block; margin-bottom:6px; color:var(--content-tertiary); font-size:11px; }.recipient-field input { box-sizing:border-box; width:100%; border:1px solid var(--border-subtle); border-radius:var(--control-radius); padding:6px 10px; color:var(--content-primary); background:var(--surface-raised); font:inherit; font-size:12px; line-height:var(--line-height-ui); outline:none; transition:border-color .16s ease,box-shadow .16s ease; }.recipient-field input:focus { border-color:var(--action-outline); box-shadow:0 0 0 3px var(--action-soft); }.send-button { width:100%; min-width:100%; flex:0 0 100%; }.result { margin:10px 0 0!important; color:var(--status-success)!important; }.result.error { color:var(--status-danger)!important; }
.preview-wrap { min-width:0; }.preview-toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; margin:0 3px 9px; color:var(--content-secondary); font-size:12px; }.preview-toolbar-actions { display:flex; align-items:center; gap:10px; }.preview-toolbar code { color:var(--content-tertiary); font:11px var(--font-family-mono); }.email-preview { min-height:620px; padding:42px 22px; display:flex; justify-content:center; align-items:flex-start; border:1px solid var(--border-default); border-radius:var(--radius-md); background:#e8e9f1; }.preview-dark { background:#181a29; }.mail-shell { width:min(100%,600px); overflow:hidden; color:#252536; background:#fbfbfd; border:1px solid #d8d9e4; border-radius:16px; box-shadow:0 18px 40px rgba(38,40,70,.16); }.preview-dark .mail-shell { color:#ececf5; background:#292b3d; border-color:#484b67; }.mail-brand { display:flex; align-items:center; gap:8px; padding:18px 24px; color:#686ba1; font-weight:700; border-bottom:1px solid #e2e3ec; }.preview-dark .mail-brand { border-color:#484b67; color:#b4b6ef; }.brand-mark { display:grid; place-items:center; width:24px; height:24px; border-radius:8px; color:#fff; background:#7b7fb2; }.brand-mark::before { content:'✦'; }.mail-type { margin-left:auto; color:#999bad; font-size:10px; letter-spacing:.08em; }.mail-content { padding:34px 36px 30px; }.mail-eyebrow { color:#7b7fb2; font-size:10px; font-weight:700; letter-spacing:.12em; }.mail-content h2 { margin:9px 0 7px; font-size:25px; }.preheader,.mail-section p,.mail-fallback { color:#77798c; font-size:13px; line-height:1.7; }.preview-dark .preheader,.preview-dark .mail-section p,.preview-dark .mail-fallback { color:#b6b7c8; }.mail-section { margin:25px 0; padding:17px; border-left:3px solid #7b7fb2; border-radius:0 8px 8px 0; background:#f1f1f8; }.preview-dark .mail-section { background:#34364b; }.mail-section strong { font-size:13px; }.mail-section p { margin:6px 0 0; }.mail-action { display:inline-block; padding:10px 17px; color:#fff; border-radius:8px; background:#7b7fb2; text-decoration:none; font-size:12px; font-weight:700; }.mail-fallback { margin:28px 0 0; padding-top:16px; border-top:1px solid #dedfe8; font-size:11px; }.preview-dark .mail-fallback { border-color:#4b4d63; }.mail-footer { padding:16px 36px 20px; color:#999bad; border-top:1px solid #e2e3ec; font-size:10px; }.mail-footer::before { content:'由咕咕发送 · SMTP 已接受不代表最终送达'; }.preview-dark .mail-footer { border-color:#484b67; }
.preview-cafe .mail-action,.preview-cafe .brand-mark { background:#9b765d; }.preview-cafe .mail-brand,.preview-cafe .mail-eyebrow { color:#9b765d; }.preview-cafe .mail-section { border-color:#9b765d; }.preview-rose .mail-action,.preview-rose .brand-mark { background:#b77898; }.preview-rose .mail-brand,.preview-rose .mail-eyebrow { color:#b77898; }.preview-rose .mail-section { border-color:#b77898; }.preview-sky .mail-action,.preview-sky .brand-mark { background:#6299b7; }.preview-sky .mail-brand,.preview-sky .mail-eyebrow { color:#6299b7; }.preview-sky .mail-section { border-color:#6299b7; }.preview-sage .mail-action,.preview-sage .brand-mark { background:#6f987b; }.preview-sage .mail-brand,.preview-sage .mail-eyebrow { color:#6f987b; }.preview-sage .mail-section { border-color:#6f987b; }
.mail-shell { width:min(100%,760px); }
.mail-brand-logo { width:28px; height:28px; object-fit:contain; }
.email-preview-frame { display:block; width:100%; height:620px; min-height:620px; border:0; border-radius:var(--radius-md); background:var(--surface-raised); overflow:hidden; scrollbar-width:thin; scrollbar-color:var(--border-default) var(--surface-raised); }
.email-preview-frame.is-dark { color-scheme:dark; scrollbar-color:var(--border-default) var(--surface-raised); }
.email-preview-frame.is-dark::-webkit-scrollbar { width:10px; height:10px; }
.email-preview-frame.is-dark::-webkit-scrollbar-track { background:var(--surface-raised); }
.email-preview-frame.is-dark::-webkit-scrollbar-thumb { background:var(--border-default); border-radius:5px; }
:global(html[data-theme='dark']) .email-preview-frame { color-scheme:dark; scrollbar-color:var(--border-default) var(--surface-raised); }
:global(html[data-theme='dark']) .email-preview-frame::-webkit-scrollbar { width:10px; height:10px; }
:global(html[data-theme='dark']) .email-preview-frame::-webkit-scrollbar-track { background:var(--surface-raised); }
:global(html[data-theme='dark']) .email-preview-frame::-webkit-scrollbar-thumb { background:var(--border-default); border-radius:5px; }
.email-preview-loading { display:grid; place-items:center; min-height:620px; color:var(--content-tertiary); font-size:12px; }
@media (max-width:820px) { .lab-layout { grid-template-columns:1fr; }.lab-controls { order:2; }.email-preview { min-height:500px; padding:24px 12px; } }
</style>
