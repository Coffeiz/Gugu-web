<template>
  <div class="sched-page">
    <div class="sched-head">
      <div>
        <h1 class="sched-title">定时任务</h1>
        <p class="sched-sub">让咕咕到点提醒你，或定时替你跑一件事</p>
      </div>
      <button class="btn-primary" @click="openCreate">＋ 新建任务</button>
    </div>

    <!-- 内置提醒 -->
    <div class="card">
      <div class="card-title">内置提醒</div>
      <div class="builtin-row">
        <div>
          <div class="builtin-name">截稿提醒</div>
          <div class="builtin-desc">每天 09:00 把 48 小时内到期的项目发给你</div>
        </div>
        <label class="switch">
          <input type="checkbox" v-model="reminders.deadline" @change="saveReminders" />
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <!-- 我的任务 -->
    <div class="card">
      <div class="card-title">我的任务 <span class="muted">（{{ tasks.length }}）</span></div>
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!tasks.length" class="empty">还没有自定义任务，点右上角「新建任务」试试～</div>
      <div v-else class="task-list">
        <div v-for="t in tasks" :key="t.id" class="task-row" :class="{ off: !t.enabled }">
          <div class="task-main">
            <div class="task-name">
              <span class="tag" :class="t.action_type">{{ t.action_type === 'agent' ? '咕咕' : '提醒' }}</span>
              {{ t.name }}
            </div>
            <div class="task-meta">
              <span>{{ cronLabel(t.cron) }}</span>
              <span class="dot">·</span>
              <span>{{ channelLabel(t.channels) }}</span>
              <span v-if="t.last_run_at" class="dot">·</span>
              <span v-if="t.last_run_at" class="muted">上次 {{ fmtTime(t.last_run_at) }}</span>
            </div>
            <div class="task-payload" v-if="t.payload">{{ t.payload }}</div>
          </div>
          <div class="task-actions">
            <button class="link" @click="runNow(t)" :disabled="busy">试运行</button>
            <button class="link" @click="openEdit(t)">编辑</button>
            <button class="link danger" @click="removeTask(t)">删除</button>
            <label class="switch sm">
              <input type="checkbox" :checked="t.enabled" @change="toggle(t)" />
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建/编辑弹窗 -->
    <div v-if="showModal" class="modal-overlay" @click.self="showModal = false">
      <div class="modal">
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
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { scheduledTasksApi } from '@/services/api'

const weekdays = ['日', '一', '二', '三', '四', '五', '六']
const tasks = ref([])
const reminders = reactive({ deadline: true })
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
    reminders.deadline = d.reminders?.deadline ?? true
  } finally { loading.value = false }
}
onMounted(load)

async function saveReminders() {
  try { await scheduledTasksApi.setReminders({ deadline: reminders.deadline }) }
  catch { reminders.deadline = !reminders.deadline }   // 失败回滚
}

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
.sched-page { max-width: 820px; margin: 0 auto; padding: 28px 24px 60px; font-family: var(--font-sans); }
.sched-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 22px; }
.sched-title { font-size: 22px; font-weight: 700; color: var(--text-primary); margin: 0; }
.sched-sub { font-size: 13px; color: var(--text-secondary); margin: 5px 0 0; }

.btn-primary { padding: 8px 16px; border-radius: 10px; border: none; background: var(--color-primary); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; font-family: var(--font-sans); }
.btn-primary:disabled { opacity: 0.5; cursor: default; }

.card { background: rgba(255,255,255,0.56); border: 1px solid rgba(0,0,0,0.08); border-radius: 16px; padding: 18px 20px; margin-bottom: 16px; }
.card-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px; }
.muted { color: var(--text-secondary); font-weight: 400; }

.builtin-row { display: flex; align-items: center; justify-content: space-between; }
.builtin-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.builtin-desc { font-size: 12px; color: var(--text-secondary); margin-top: 3px; }

.empty { font-size: 13px; color: var(--text-secondary); padding: 14px 2px; }
.task-list { display: flex; flex-direction: column; gap: 10px; }
.task-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.5); border: 1px solid rgba(0,0,0,0.06); }
.task-row.off { opacity: 0.55; }
.task-name { font-size: 14px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 6px; font-weight: 500; }
.tag.reminder { background: rgba(123,127,178,0.16); color: #5b5fa6; }
.tag.agent { background: rgba(29,158,117,0.16); color: #0f6e56; }
.task-meta { font-size: 12px; color: var(--text-secondary); margin-top: 5px; display: flex; gap: 6px; flex-wrap: wrap; }
.dot { opacity: 0.5; }
.task-payload { font-size: 12px; color: var(--text-secondary); margin-top: 5px; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.link { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--text-secondary); padding: 2px 4px; font-family: var(--font-sans); }
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

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.32); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(2px); }
.modal { width: 440px; max-width: 92vw; background: #fff; border-radius: 18px; padding: 22px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.22); }
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
