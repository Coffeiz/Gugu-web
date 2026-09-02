<template>
  <div class="email-page">
    <div class="page-head">
      <div>
        <h2>{{ t('adminEmailUi.title') }}</h2>
        <p>{{ t('adminEmailUi.description') }}</p>
      </div>
      <div class="recipient-stat">
        <span>{{ t('adminEmailUi.subscribed') }}</span><strong>{{ recipientCount ?? '—' }}</strong>
        <RefreshButton :loading="countLoading" @click="loadCount" :title="t('adminEmailUi.refreshCount')" />
      </div>
    </div>

    <div class="email-grid">
      <section class="editor-card">
        <div class="section-title">{{ t('adminEmailUi.content') }}</div>
        <div class="locale-row">
          <button v-for="item in locales" :key="item.value" class="chip" :class="{ active: activeLocale === item.value }" @click="switchLocale(item.value)">{{ t(`adminEmailUi.languages.${item.value}`) }}</button>
          <ActionButton variant="primary" fit :disabled="translating" @click="translateAll">{{ translating ? t('adminEmailUi.translating') : t('adminEmailUi.translate') }}</ActionButton>
        </div>
        <div class="field-grid">
          <label>{{ t('adminEmailUi.template') }}<select v-model="form.template"><option v-for="item in templates" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
          <label>{{ t('adminEmailUi.subject') }}<input v-model="form.subject" maxlength="200" :placeholder="t('adminEmailUi.subjectPlaceholder')" /></label>
          <label>{{ t('adminEmailUi.titleLabel') }}<input v-model="form.title" maxlength="200" :placeholder="t('adminEmailUi.titlePlaceholder')" /></label>
          <label>{{ t('adminEmailUi.preheader') }}<input v-model="form.preheader" maxlength="180" :placeholder="t('adminEmailUi.preheaderPlaceholder')" /></label>
        </div>
        <div class="toggle-row"><span>{{ t('adminEmailUi.theme') }}</span><button v-for="item in themes" :key="item" class="chip" :class="{ active: form.theme === item }" @click="form.theme = item">{{ item === 'light' ? t('adminEmailUi.light') : t('adminEmailUi.dark') }}</button><span>{{ t('adminEmailUi.palette') }}</span><button v-for="item in palettes" :key="item" class="chip" :class="{ active: form.palette === item }" @click="form.palette = item">{{ item }}</button></div>
        <label class="field-block">{{ t('adminEmailUi.body') }}<textarea v-model="form.body" rows="7" maxlength="20000" :placeholder="t('adminEmailUi.bodyPlaceholder')" /></label>

        <div class="subhead">{{ t('adminEmailUi.contentBlocks') }} <button class="small-btn" @click="addSection">{{ t('adminEmailUi.add') }}</button></div>
        <div v-for="(section, index) in form.sections" :key="index" class="repeat-row">
          <input v-model="section.heading" :placeholder="t('adminEmailUi.sectionHeadingPlaceholder')" /><input v-model="section.text" :placeholder="t('adminEmailUi.sectionTextPlaceholder')" /><button class="remove-btn" @click="form.sections.splice(index, 1)">{{ t('adminEmailUi.delete') }}</button>
        </div>
        <div class="subhead">{{ t('adminEmailUi.actions') }} <button class="small-btn" :disabled="form.actions.length >= 3" @click="addAction">{{ t('adminEmailUi.add') }}</button></div>
        <div v-for="(action, index) in form.actions" :key="index" class="repeat-row">
          <input v-model="action.label" :placeholder="t('adminEmailUi.actionLabelPlaceholder')" /><input v-model="action.url" :placeholder="t('adminEmailUi.urlPlaceholder')" /><button class="remove-btn" @click="form.actions.splice(index, 1)">{{ t('adminEmailUi.delete') }}</button>
        </div>

        <div class="send-panel">
          <div class="subhead">{{ t('adminEmailUi.sendTest') }}</div>
          <div class="send-row"><input v-model="testRecipient" type="email" :placeholder="t('adminEmailUi.testRecipient')" /><ActionButton variant="secondary" fit :disabled="testing" @click="sendTest">{{ testing ? t('adminEmailUi.sending') : t('adminEmailUi.sendTest') }}</ActionButton></div>
          <p class="hint">{{ t('adminEmailUi.testHint') }}</p>
          <div class="publish-row"><span>{{ t('adminEmailUi.publishHint', { count: recipientCount ?? '—' }) }}</span><ActionButton fit :disabled="publishing || !recipientCount" @click="publish">{{ publishing ? t('adminEmailUi.queued') : t('adminEmailUi.publish') }}</ActionButton></div>
        </div>
      </section>

      <section class="preview-card">
        <div class="preview-head"><span>{{ t('adminEmailUi.preview') }}</span><code>{{ activeLocale }} · {{ form.template }} · {{ form.theme }} · {{ form.palette }}</code><ActionButton variant="secondary" fit @click="refreshPreview">{{ t('adminEmailUi.refreshPreview') }}</ActionButton></div>
        <iframe class="preview-frame" :title="t('adminEmailUi.previewTitle')" :srcdoc="previewHtml" />
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import RefreshButton from '@/components/common/controls/RefreshButton.vue'
import { useAdminStore } from '@/stores/admin'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { showAppError, showAppSuccess } from '@/composables/core/useAppToast'

type Section = { heading: string; text: string }
type Action = { label: string; url: string }
type Locale = 'zh-CN' | 'ja-JP' | 'en-US'
type LocalizedContent = Pick<typeof form, 'subject' | 'title' | 'preheader' | 'body' | 'sections' | 'actions'>
const admin = useAdminStore()
const { t } = useI18n()
const templates = [
  { value: 'notification', label: '通知' }, { value: 'reminder', label: '提醒' }, { value: 'report', label: '报告' }, { value: 'security', label: '安全' }, { value: 'test', label: '测试' },
]
const themes = ['light', 'dark'] as const
const palettes = ['mist', 'cafe', 'rose', 'sky', 'sage'] as const
const form = reactive({ template: 'notification', theme: 'light', palette: 'mist', subject: '咕咕 · 站点通知', title: '邮件标题', preheader: '', body: '这是来自咕咕的站点邮件。', sections: [] as Section[], actions: [] as Action[] })
const locales: Array<{ value: Locale }> = [{ value: 'zh-CN' }, { value: 'ja-JP' }, { value: 'en-US' }]
const activeLocale = ref<Locale>('zh-CN')
const translations = reactive<Partial<Record<Locale, LocalizedContent>>>({})
const translating = ref(false)
const previewHtml = ref('')
const recipientCount = ref<number | null>(null)
const countLoading = ref(false)
const testRecipient = ref('')
const testing = ref(false)
const publishing = ref(false)
let previewTimer: ReturnType<typeof setTimeout> | undefined

function snapshot(): LocalizedContent { return { subject: form.subject, title: form.title, preheader: form.preheader, body: form.body, sections: form.sections.map(item => ({ ...item })), actions: form.actions.map(item => ({ ...item })) } }
function blankContent(): LocalizedContent { return { subject: '', title: '', preheader: '', body: '', sections: [], actions: [] } }
function switchLocale(locale: Locale) { if (locale === activeLocale.value) return; translations[activeLocale.value] = snapshot(); activeLocale.value = locale; const next = translations[locale] || (locale === 'zh-CN' ? translations['zh-CN'] : blankContent()); Object.assign(form, next || blankContent()) }
function payload() { translations[activeLocale.value] = snapshot(); const base = translations['zh-CN'] || snapshot(); return { ...form, ...base, template: form.template, theme: form.theme, palette: form.palette, translations: Object.fromEntries(Object.entries(translations).filter(([, value]) => value)) } }
async function request(path: string, options: RequestInit = {}) {
  const response = await admin.authFetch(`/api/v1/admin/email${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || data.message || `请求失败（${response.status}）`)
  return data
}
async function refreshPreview() {
  try { previewHtml.value = (await request('/preview', { method: 'POST', body: JSON.stringify({ ...form, sections: form.sections, actions: form.actions }) })).html } catch (error) { showAppError(error instanceof Error ? error.message : t('adminEmailUi.previewFailed')) }
}
async function loadCount() { countLoading.value = true; try { recipientCount.value = (await request('/recipient-count')).count } catch (error) { showAppError(error instanceof Error ? error.message : t('adminEmailUi.countFailed')) } finally { countLoading.value = false } }
function addSection() { if (form.sections.length < 8) form.sections.push({ heading: '', text: '' }) }
function addAction() { if (form.actions.length < 3) form.actions.push({ label: '查看详情', url: 'https://' }) }
async function sendTest() {
  if (!testRecipient.value.trim()) return showAppError(t('adminEmailUi.fillRecipient'))
  testing.value = true
  try { const data = await request('/test', { method: 'POST', body: JSON.stringify({ ...payload(), recipient: testRecipient.value, test_locale: activeLocale.value }) }); if (!data.ok) throw new Error(data.message || t('adminEmailUi.testFailed')); showAppSuccess(t('adminEmailUi.testSubmitted')) } catch (error) { showAppError(error instanceof Error ? error.message : t('adminEmailUi.testFailed')) } finally { testing.value = false }
}
async function translateAll() {
  translations[activeLocale.value] = snapshot(); translating.value = true
  try { const data = await request('/translate', { method: 'POST', body: JSON.stringify(payload()) }); Object.assign(translations, data.translations || {}); if (activeLocale.value !== 'zh-CN') Object.assign(form, translations[activeLocale.value] || blankContent()); showAppSuccess(t('adminEmailUi.translate')) } catch (error) { showAppError(error instanceof Error ? error.message : t('adminEmailUi.translationFailed')) } finally { translating.value = false }
}
async function publish() {
  if (!recipientCount.value) return
  const ok = await confirmDialog({ title: t('adminEmailUi.confirmTitle'), message: t('adminEmailUi.confirmMessage', { count: recipientCount.value }), tone: 'danger', confirmText: t('adminEmailUi.confirmPublish') })
  if (!ok) return
  publishing.value = true
  try { const data = await request('/publish', { method: 'POST', body: JSON.stringify({ ...payload(), confirm: true }) }); showAppSuccess(t('adminEmailUi.publishSuccess', { count: data.recipient_count })) } catch (error) { showAppError(error instanceof Error ? error.message : t('adminEmailUi.publishFailed')) } finally { publishing.value = false }
}
watch(form, () => { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 180) }, { deep: true })
onMounted(() => { void Promise.all([refreshPreview(), loadCount()]) })
</script>

<style scoped>
.email-page { min-height:100%; padding:30px 36px 56px; color:rgba(255,255,255,.88); }
.page-head,.preview-head,.publish-row,.send-row { display:flex; align-items:center; justify-content:space-between; gap:14px; }
.page-head { margin-bottom:22px; } h2 { margin:0; font-size:22px; } p { margin:7px 0 0; color:rgba(255,255,255,.4); font-size:12px; }
.recipient-stat { display:flex; align-items:center; gap:10px; color:rgba(255,255,255,.48); font-size:12px; } .recipient-stat strong { font-size:22px; color:rgba(255,255,255,.9); }
.email-grid { display:grid; grid-template-columns:minmax(420px, 520px) minmax(0,1fr); gap:20px; align-items:start; }
.editor-card,.preview-card { background:rgba(255,255,255,.045); border:1px solid rgba(255,255,255,.1); border-radius:14px; padding:22px; min-width:0; }
.section-title,.subhead { font-size:13px; font-weight:700; color:rgba(255,255,255,.72); margin-bottom:16px; } .subhead { display:flex; align-items:center; gap:8px; margin-top:22px; margin-bottom:9px; } .subhead > button { margin-left:auto; } .locale-row { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin:-4px 0 16px; } .locale-row :deep(.app-action-button) { margin-left:auto; }
.field-grid { display:grid; grid-template-columns:1fr 1fr; gap:13px; } label { display:flex; flex-direction:column; gap:7px; color:rgba(255,255,255,.42); font-size:11px; }
input,textarea,select { box-sizing:border-box; width:100%; border:1px solid var(--input-border); border-radius:9px; background:var(--input-bg); color:var(--input-fg); padding:10px 11px; font:13px/1.45 var(--font-sans); outline:none; } textarea { resize:vertical; min-height:130px; } input:focus,textarea:focus,select:focus { border-color:var(--input-border-focus); }
.field-block { margin-top:15px; } .toggle-row { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin:17px 0 2px; color:rgba(255,255,255,.4); font-size:11px; } .toggle-row span:not(:first-child) { margin-left:10px; }
.chip,.small-btn,.remove-btn { box-sizing:border-box; min-height:34px; border:1px solid rgba(255,255,255,.13); border-radius:8px; background:rgba(255,255,255,.05); color:rgba(255,255,255,.62); padding:8px 10px; cursor:pointer; font:12px/1.2 var(--font-sans); } .chip.active { border-color:rgba(123,127,178,.58); color:var(--content-on-accent); background:var(--action-primary-bg); }
.repeat-row { display:grid; grid-template-columns:1fr 1.4fr auto; gap:8px; margin-bottom:8px; } .remove-btn { color:#d49494; }
.send-panel { border-top:1px solid rgba(255,255,255,.1); margin-top:23px; padding-top:17px; } .send-row input { flex:1; } :deep(.send-row .app-action-button) { height:41px; min-height:41px; } .hint { margin:8px 0 17px; font-size:11px; } .publish-row { align-items:center; flex-wrap:wrap; padding-top:15px; border-top:1px solid rgba(255,255,255,.1); font-size:12px; color:rgba(255,255,255,.5); } .publish-row > span { min-width:0; flex:1 1 180px; line-height:1.45; }
.preview-card { min-height:720px; } .preview-head { margin-bottom:13px; color:rgba(255,255,255,.55); font-size:12px; } .preview-head code { margin-left:auto; color:rgba(255,255,255,.28); } .preview-frame { display:block; width:100%; height:690px; border:0; border-radius:10px; background:#f3f4f8; }
@media (max-width:1000px) { .email-grid { grid-template-columns:1fr; } .preview-card { min-height:500px; } .preview-frame { height:600px; } } @media (max-width:620px) { .email-page { padding:20px 16px; } .field-grid { grid-template-columns:1fr; } .repeat-row { grid-template-columns:1fr; } .page-head { align-items:flex-start; flex-direction:column; } }
</style>
