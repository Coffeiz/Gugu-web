<template>
  <div class="sched-page">
    <div class="panel">
      <div class="section-header">
        <button class="btn-primary" @click="openCreate">＋ 新建任务</button>
      </div>
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!tasks.length" class="empty">还没有自定义任务，点右上角「新建任务」试试～</div>
      <div v-else class="task-grid">
        <div v-for="t in tasks" :key="t.id" class="task-card" :class="{ off: !t.enabled }">
          <div class="tc-top">
            <span class="tag" :class="t.action_type">{{ t.action_type === 'agent' ? '咕咕' : '提醒' }}</span>
            <span class="tc-name">{{ t.name }}</span>
            <label class="switch sm">
              <input type="checkbox" :checked="t.enabled" @change="toggle(t)" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="tc-when">{{ cronLabel(t.cron) }} · {{ channelLabel(t.channels) }}</div>
          <div class="tc-payload" v-if="t.payload">{{ t.payload }}</div>
          <div class="tc-foot">
            <span class="tc-last">{{ t.last_run_at ? '上次 ' + fmtTime(t.last_run_at) : '未运行' }}</span>
            <span class="tc-acts">
              <button class="link" @click="runNow(t)" :disabled="busy">试运行</button>
              <button class="link" @click="openEdit(t)">编辑</button>
              <button class="link danger" @click="removeTask(t)">删除</button>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建/编辑弹窗（共享 BaseModal，与项目弹窗同款风格+动画）-->
    <BaseModal :show="showModal" width="440px" @close="showModal = false">
      <div class="sched-modal">
        <div class="modal-title">{{ editing ? '编辑任务' : '新建任务' }}</div>

        <label class="field">
          <span>名称</span>
          <input v-model="form.name" placeholder="如：每早待办、喝水提醒" maxlength="100" />
        </label>

        <label class="field">
          <span>类型</span>
          <div class="seg">
            <button :class="{ on: form.action_type === 'reminder' }" @click="form.action_type = 'reminder'">提醒</button>
            <button :class="{ on: form.action_type === 'agent' }" @click="form.action_type = 'agent'">让咕咕做事</button>
          </div>
        </label>

        <label class="field">
          <span>{{ form.action_type === 'agent' ? '给咕咕的指令' : '提醒内容' }}</span>
          <textarea v-model="form.payload" rows="2"
            :placeholder="form.action_type === 'agent' ? '如：把今天到期的待办列给我' : '如：该喝水啦～'"></textarea>
        </label>

        <label class="field">
          <span>什么时候</span>
          <div class="when">
            <select v-model="form.freq">
              <option value="daily">每天</option>
              <option value="weekday">工作日（周一至周五）</option>
              <option value="weekly">每周</option>
            </select>
            <select v-if="form.freq === 'weekly'" v-model.number="form.weekday">
              <option v-for="(w, i) in weekdays" :key="i" :value="i === 0 ? 0 : i">周{{ w }}</option>
            </select>
            <input type="time" v-model="form.time" />
          </div>
        </label>

        <label class="field">
          <span>发到哪</span>
          <div class="chans">
            <label><input type="checkbox" value="chat" v-model="form.channels" /> 咕咕聊天</label>
            <label><input type="checkbox" value="im" v-model="form.channels" /> 飞书 / QQ</label>
          </div>
        </label>

        <div v-if="formErr" class="form-err">{{ formErr }}</div>
        <div class="modal-actions">
          <button class="link" @click="showModal = false">取消</button>
          <button class="btn-primary" @click="submit" :disabled="busy">{{ editing ? '保存' : '创建' }}</button>
        </div>
      </div>
    </BaseModal>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { scheduledTasksApi } from '@/services/api'
import BaseModal from '@/components/common/BaseModal.vue'

const weekdays = ['日', '一', '二', '三', '四', '五', '六']
const tasks = ref([])
const loading = ref(true)
const busy = ref(false)
const showModal = ref(false)
const editing = ref(null)
const formErr = ref('')
const form = reactive({ name: '', action_type: 'reminder', payload: '', freq: 'daily', weekday: 1, time: '09:00', channels: ['chat'] })

async function load() {
  loading.value = true
  try {
    const d = await scheduledTasksApi.list()
    tasks.value = d.tasks || []
  } finally { loading.value = false }
}
onMounted(load)

function openCreate() {
  editing.value = null
  Object.assign(form, { name: '', action_type: 'reminder', payload: '', freq: 'daily', weekday: 1, time: '09:00', channels: ['chat'] })
  formErr.value = ''
  showModal.value = true
}
function openEdit(t) {
  editing.value = t
  const { freq, weekday, time } = parseCron(t.cron)
  Object.assign(form, { name: t.name, action_type: t.action_type, payload: t.payload, freq, weekday, time, channels: [...t.channels] })
  formErr.value = ''
  showModal.value = true
}

function buildCron() {
  const [h, m] = form.time.split(':').map(Number)
  if (form.freq === 'daily')   return `${m} ${h} * * *`
  if (form.freq === 'weekday') return `${m} ${h} * * 1-5`
  return `${m} ${h} * * ${form.weekday}`
}
function parseCron(cron) {
  const p = (cron || '').split(' ')
  if (p.length !== 5) return { freq: 'daily', weekday: 1, time: '09:00' }
  const [m, h, , , dow] = p
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  if (dow === '*') return { freq: 'daily', weekday: 1, time }
  if (dow === '1-5') return { freq: 'weekday', weekday: 1, time }
  return { freq: 'weekly', weekday: Number(dow) || 0, time }
}
function cronLabel(cron) {
  const { freq, weekday, time } = parseCron(cron)
  if (freq === 'daily')   return `每天 ${time}`
  if (freq === 'weekday') return `工作日 ${time}`
  return `每周${weekdays[weekday] ?? ''} ${time}`
}
function channelLabel(chs) {
  const map = { chat: '聊天', im: '飞书/QQ' }
  return (chs || []).map(c => map[c] || c).join(' + ') || '—'
}
function fmtTime(iso) {
  try { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  catch { return '' }
}

async function submit() {
  if (!form.name.trim()) { formErr.value = '名称不能为空'; return }
  if (!form.channels.length) { formErr.value = '至少选一个发送渠道'; return }
  busy.value = true; formErr.value = ''
  const data = { name: form.name.trim(), action_type: form.action_type, payload: form.payload, cron: buildCron(), channels: [...form.channels], enabled: editing.value ? editing.value.enabled : true }
  try {
    if (editing.value) await scheduledTasksApi.update(editing.value.id, data)
    else await scheduledTasksApi.create(data)
    showModal.value = false
    await load()
  } catch (e) { formErr.value = e?.message || '保存失败' }
  finally { busy.value = false }
}
async function toggle(t) {
  try { await scheduledTasksApi.update(t.id, { enabled: !t.enabled }); await load() }
  catch {}
}
async function runNow(t) {
  busy.value = true
  try { const r = await scheduledTasksApi.run(t.id); alert(r.msg || '已执行一次'); await load() }
  catch (e) { alert('执行失败：' + (e?.message || '')) }
  finally { busy.value = false }
}
async function removeTask(t) {
  if (!confirm(`删除「${t.name}」？`)) return
  try { await scheduledTasksApi.delete(t.id); await load() } catch {}
}
</script>

<style scoped>
.sched-page { height: 100%; font-family: var(--font-sans); }

/* 和顶栏「新建项目」按钮一致 */
.btn-primary {
  padding: 8px 16px; border: none; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: #fff;
  font-size: 13px; font-weight: 600; cursor: pointer; font-family: var(--font-sans);
  box-shadow: 0 3px 12px rgba(123,127,178,0.3);
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.2s ease-out, opacity 0.2s ease-out;
}
.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(123,127,178,0.4); opacity: 0.92; }
.btn-primary:disabled { opacity: 0.5; cursor: default; transform: none; }

/* 大版面：填满内容区（等宽 + 高到顶栏底），对齐原型 .glass-panel */
.panel {
  height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column;
  background: rgba(255,255,255,0.34); border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg); corner-shape: squircle;
  box-shadow: var(--glass-shadow);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  padding: 22px 24px;
}
.section-header { display: flex; align-items: center; justify-content: flex-start; margin-bottom: 16px; flex-shrink: 0; }

.empty { font-size: 13px; color: var(--text-secondary); padding: 8px 2px; }

/* 版面里的小卡片（更实一点，浮在大版面上）；区域内滚动，撑满剩余高度 */
/* 滚动容器；用内边距给 hover 上浮+阴影留空间（否则顶部被 overflow 裁掉），负 margin 抵消让卡片仍贴边对齐 */
.task-grid {
  flex: 1; min-height: 0; overflow-y: auto; align-content: start;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(264px, 1fr)); gap: 12px;
  margin: 0 -8px; padding: 10px 8px 16px;
}
/* 与项目卡片同款：squircle + 顶部高光 ::after + hover 上浮 */
.task-card {
  position: relative;
  background: rgba(255,255,255,0.56); border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-md); corner-shape: squircle;
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  padding: 13px 15px; display: flex; flex-direction: column; gap: 7px;
  overflow: hidden;
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.3s ease, background 0.25s ease-out;
}
.task-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit; corner-shape: squircle;
  background: linear-gradient(to top, rgba(255,255,255,0.08), transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: background 0.3s cubic-bezier(0.34,1.2,0.64,1); pointer-events: none;
}
.task-card > * { position: relative; z-index: 1; }
.task-card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
.task-card:hover::after { background: linear-gradient(to top, rgba(255,255,255,0.25), rgba(255,255,255,0.05) 50%); }
.task-card.off { opacity: 0.5; }
.tc-top { display: flex; align-items: center; gap: 8px; }
.tc-name { font-size: 14px; font-weight: 600; color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 6px; font-weight: 500; flex-shrink: 0; }
.tag.reminder { background: rgba(123,127,178,0.16); color: #5b5fa6; }
.tag.agent { background: rgba(29,158,117,0.16); color: #0f6e56; }
.tc-when { font-size: 12px; color: var(--text-secondary); }
.tc-payload { font-size: 12px; color: var(--text-secondary); background: rgba(0,0,0,0.035); border-radius: 8px; padding: 6px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
.tc-last { font-size: 11px; color: var(--text-secondary); opacity: 0.75; }
.tc-acts { display: flex; gap: 8px; }
.link { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--text-secondary); padding: 2px 3px; font-family: var(--font-sans); }
.link:hover { color: var(--text-primary); }
.link.danger:hover { color: #d05a5a; }
.link:disabled { opacity: 0.5; cursor: default; }

.switch { position: relative; display: inline-block; width: 38px; height: 22px; flex-shrink: 0; }
.switch.sm { width: 32px; height: 19px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; inset: 0; background: rgba(0,0,0,0.18); border-radius: 22px; transition: 0.2s; cursor: pointer; }
.slider::before { content: ''; position: absolute; height: 16px; width: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
.switch.sm .slider::before { height: 13px; width: 13px; }
.switch input:checked + .slider { background: var(--color-primary); }
.switch input:checked + .slider::before { transform: translateX(16px); }
.switch.sm input:checked + .slider::before { transform: translateX(13px); }

.sched-modal { padding: 22px 24px; }
.modal-title { font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 16px; }
.field { display: block; margin-bottom: 14px; }
.field > span { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.field input[type=text], .field input:not([type]), .field textarea, .field select, .field input[type=time] {
  width: 100%; box-sizing: border-box; padding: 8px 11px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.14); font-size: 13px; font-family: var(--font-sans); color: var(--text-primary); background: #fff;
}
.field textarea { resize: vertical; }
.seg { display: flex; gap: 8px; }
.seg button { flex: 1; padding: 8px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.14); background: #fff; font-size: 13px; cursor: pointer; color: var(--text-secondary); font-family: var(--font-sans); }
.seg button.on { background: var(--color-primary); color: #fff; border-color: transparent; }
.when { display: flex; gap: 8px; }
.when select { flex: 1; }
.when input[type=time] { width: 120px; }
.chans { display: flex; gap: 18px; font-size: 13px; color: var(--text-primary); }
.chans label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.form-err { color: #d05a5a; font-size: 12px; margin-bottom: 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; align-items: center; margin-top: 6px; }
</style>
