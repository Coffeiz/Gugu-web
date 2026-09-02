<template>
  <div class="email-page">
    <div class="page-head">
      <div>
        <h2>邮件发布</h2>
        <p>使用咕咕统一邮件模板编辑、预览并发送站点邮件。</p>
      </div>
      <div class="recipient-stat">
        <span>有效注册用户</span><strong>{{ recipientCount ?? '—' }}</strong>
        <button class="icon-btn" title="刷新人数" @click="loadCount"><Icon name="action.refresh" size="sm" /></button>
      </div>
    </div>

    <div class="email-grid">
      <section class="editor-card">
        <div class="section-title">邮件内容</div>
        <div class="field-grid">
          <label>模板<select v-model="form.template"><option v-for="item in templates" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
          <label>主题行<input v-model="form.subject" maxlength="200" placeholder="邮件主题" /></label>
          <label>邮件标题<input v-model="form.title" maxlength="200" placeholder="收件人看到的主标题" /></label>
          <label>摘要<input v-model="form.preheader" maxlength="180" placeholder="列表预览摘要（可选）" /></label>
        </div>
        <div class="toggle-row"><span>主题</span><button v-for="item in themes" :key="item" class="chip" :class="{ active: form.theme === item }" @click="form.theme = item">{{ item === 'light' ? '亮色' : '暗色' }}</button><span>配色</span><button v-for="item in palettes" :key="item" class="chip" :class="{ active: form.palette === item }" @click="form.palette = item">{{ item }}</button></div>
        <label class="field-block">正文<textarea v-model="form.body" rows="7" maxlength="20000" placeholder="输入邮件正文，预览会同步更新" /></label>

        <div class="subhead">内容区块 <button class="small-btn" @click="addSection">＋添加</button></div>
        <div v-for="(section, index) in form.sections" :key="index" class="repeat-row">
          <input v-model="section.heading" placeholder="区块标题（可选）" /><input v-model="section.text" placeholder="区块内容" /><button class="remove-btn" @click="form.sections.splice(index, 1)">删除</button>
        </div>
        <div class="subhead">操作按钮 <button class="small-btn" :disabled="form.actions.length >= 3" @click="addAction">＋添加</button></div>
        <div v-for="(action, index) in form.actions" :key="index" class="repeat-row">
          <input v-model="action.label" placeholder="按钮文字" /><input v-model="action.url" placeholder="https://example.com" /><button class="remove-btn" @click="form.actions.splice(index, 1)">删除</button>
        </div>

        <div class="send-panel">
          <div class="subhead">发送测试</div>
          <div class="send-row"><input v-model="testRecipient" type="email" placeholder="测试收件人邮箱" /><ActionButton variant="secondary" fit :disabled="testing" @click="sendTest">{{ testing ? '发送中…' : '发送测试' }}</ActionButton></div>
          <p class="hint">测试邮件使用系统 SMTP，仅发送到上方填写的地址。</p>
          <div class="publish-row"><span>正式发布将发送给 {{ recipientCount ?? '—' }} 位有效注册用户</span><ActionButton :disabled="publishing || !recipientCount" @click="publish">{{ publishing ? '已提交…' : '发布给全部用户' }}</ActionButton></div>
        </div>
      </section>

      <section class="preview-card">
        <div class="preview-head"><span>实时预览</span><code>{{ form.template }} · {{ form.theme }} · {{ form.palette }}</code><ActionButton variant="secondary" fit @click="refreshPreview">刷新预览</ActionButton></div>
        <iframe class="preview-frame" title="邮件预览" :srcdoc="previewHtml" />
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch, onMounted } from 'vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useAdminStore } from '@/stores/admin'
import { confirmDialog } from '@/composables/useConfirmDialog'
import { showAppError, showAppSuccess } from '@/composables/useAppToast'

type Section = { heading: string; text: string }
type Action = { label: string; url: string }
const admin = useAdminStore()
const templates = [
  { value: 'notification', label: '通知' }, { value: 'reminder', label: '提醒' }, { value: 'report', label: '报告' }, { value: 'security', label: '安全' }, { value: 'test', label: '测试' },
]
const themes = ['light', 'dark'] as const
const palettes = ['mist', 'cafe', 'rose', 'sky', 'sage'] as const
const form = reactive({ template: 'notification', theme: 'light', palette: 'mist', subject: '咕咕 · 站点通知', title: '邮件标题', preheader: '', body: '这是来自咕咕的站点邮件。', sections: [] as Section[], actions: [] as Action[] })
const previewHtml = ref('')
const recipientCount = ref<number | null>(null)
const testRecipient = ref('')
const testing = ref(false)
const publishing = ref(false)
let previewTimer: ReturnType<typeof setTimeout> | undefined

function payload() { return { ...form, sections: form.sections, actions: form.actions } }
async function request(path: string, options: RequestInit = {}) {
  const response = await admin.authFetch(`/api/v1/admin/email${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || data.message || `请求失败（${response.status}）`)
  return data
}
async function refreshPreview() {
  try { previewHtml.value = (await request('/preview', { method: 'POST', body: JSON.stringify(payload()) })).html } catch (error) { showAppError(error instanceof Error ? error.message : '预览失败') }
}
async function loadCount() { try { recipientCount.value = (await request('/recipient-count')).count } catch (error) { showAppError(error instanceof Error ? error.message : '无法读取收件人数') } }
function addSection() { if (form.sections.length < 8) form.sections.push({ heading: '', text: '' }) }
function addAction() { if (form.actions.length < 3) form.actions.push({ label: '查看详情', url: 'https://' }) }
async function sendTest() {
  if (!testRecipient.value.trim()) return showAppError('请填写测试收件人邮箱')
  testing.value = true
  try { const data = await request('/test', { method: 'POST', body: JSON.stringify({ ...payload(), recipient: testRecipient.value }) }); if (!data.ok) throw new Error(data.message || '测试邮件发送失败'); showAppSuccess('测试邮件已提交给 SMTP') } catch (error) { showAppError(error instanceof Error ? error.message : '测试邮件发送失败') } finally { testing.value = false }
}
async function publish() {
  if (!recipientCount.value) return
  const ok = await confirmDialog({ title: '确认发布邮件', message: `将使用系统 SMTP 向 ${recipientCount.value} 位有效注册用户发送这封邮件。邮件提交后无法撤回，确定继续吗？`, tone: 'danger', confirmText: '确认发布' })
  if (!ok) return
  publishing.value = true
  try { const data = await request('/publish', { method: 'POST', body: JSON.stringify({ ...payload(), confirm: true }) }); showAppSuccess(`邮件已加入发送队列，共 ${data.recipient_count} 位收件人`) } catch (error) { showAppError(error instanceof Error ? error.message : '邮件发布失败') } finally { publishing.value = false }
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
.section-title,.subhead { font-size:13px; font-weight:700; color:rgba(255,255,255,.72); margin-bottom:16px; } .subhead { margin-top:22px; margin-bottom:9px; }
.field-grid { display:grid; grid-template-columns:1fr 1fr; gap:13px; } label { display:flex; flex-direction:column; gap:7px; color:rgba(255,255,255,.42); font-size:11px; }
input,textarea,select { box-sizing:border-box; width:100%; border:1px solid var(--input-border); border-radius:9px; background:var(--input-bg); color:var(--input-fg); padding:10px 11px; font:13px/1.45 var(--font-sans); outline:none; } textarea { resize:vertical; min-height:130px; } input:focus,textarea:focus,select:focus { border-color:var(--input-border-focus); }
.field-block { margin-top:15px; } .toggle-row { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin:17px 0 2px; color:rgba(255,255,255,.4); font-size:11px; } .toggle-row span:not(:first-child) { margin-left:10px; }
.chip,.small-btn,.remove-btn { border:1px solid rgba(255,255,255,.13); border-radius:8px; background:rgba(255,255,255,.05); color:rgba(255,255,255,.62); padding:6px 10px; cursor:pointer; font:12px var(--font-sans); } .chip.active { border-color:var(--action-primary-bg); color:var(--content-on-accent); background:var(--action-primary-bg); }
.repeat-row { display:grid; grid-template-columns:1fr 1.4fr auto; gap:8px; margin-bottom:8px; } .remove-btn { color:#d49494; }
.send-panel { border-top:1px solid rgba(255,255,255,.1); margin-top:23px; padding-top:17px; } .send-row input { flex:1; } .hint { margin:8px 0 17px; font-size:11px; } .publish-row { padding-top:15px; border-top:1px solid rgba(255,255,255,.1); font-size:12px; color:rgba(255,255,255,.5); }
.preview-card { min-height:720px; } .preview-head { margin-bottom:13px; color:rgba(255,255,255,.55); font-size:12px; } .preview-head code { margin-left:auto; color:rgba(255,255,255,.28); } .preview-frame { display:block; width:100%; height:690px; border:0; border-radius:10px; background:#f3f4f8; }
@media (max-width:1000px) { .email-grid { grid-template-columns:1fr; } .preview-card { min-height:500px; } .preview-frame { height:600px; } } @media (max-width:620px) { .email-page { padding:20px 16px; } .field-grid { grid-template-columns:1fr; } .repeat-row { grid-template-columns:1fr; } .page-head { align-items:flex-start; flex-direction:column; } }
</style>
