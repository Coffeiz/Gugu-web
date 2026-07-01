<template>
  <div class="sched-page">
    <div class="panel">
      <div class="section-header">
        <button class="btn-primary" @click="openCreate"><PhAlarm :size="14" weight="bold" style="vertical-align:-1px;margin-right:5px" />新建任务</button>
      </div>
      <div v-if="!loading && !tasks.length" class="empty">还没有自定义任务，点上方「新建任务」试试～</div>
      <div v-else-if="tasks.length" class="task-grid">
        <div v-for="t in tasks" :key="t.id" class="task-card" :class="{ off: !t.enabled }">
          <div class="tc-top">
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
    <BaseModal :show="showModal" width="360px" @close="showModal = false">
      <div class="sched-modal">
        <input v-model="form.name" ref="nameRef" class="title-input" placeholder="任务名称" maxlength="100" />
        <div class="divider divider-full"></div>

        <label class="field">
          <span>提醒内容</span>
          <textarea v-model="form.payload" rows="2" placeholder="如：收集昨天的科技新闻"></textarea>
        </label>
        <div class="divider"></div>

        <div class="field">
          <span>重复</span>
          <div class="repeat-tabs">
            <button v-for="opt in REPEAT_OPTS" :key="opt.v" type="button"
              class="repeat-tab" :class="{ on: repeatMode === opt.v }"
              @click="repeatMode = opt.v">{{ opt.label }}</button>
          </div>
          <div v-if="repeatMode === 'custom'" class="date-range">
            <DatePicker v-model="customStartDate" placeholder="选择日期" />
          </div>
        </div>
        <div class="divider"></div>

        <label class="field time-field">
          <span>时间</span>
          <input type="text" v-model="form.time" placeholder="HH:MM" autocomplete="off" />
        </label>
        <div class="divider"></div>

        <div class="field">
          <span>发到哪</span>
          <div class="chans">
            <label class="chk-row">
              <input type="checkbox" value="web" v-model="form.channels" class="chk-input" />
              <span class="chk-box">
                <svg v-if="form.channels.includes('web')" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              web 通知
            </label>
            <label v-if="imChannels.includes('feishu')" class="chk-row">
              <input type="checkbox" value="feishu" v-model="form.channels" class="chk-input" />
              <span class="chk-box">
                <svg v-if="form.channels.includes('feishu')" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              飞书
            </label>
            <label v-if="imChannels.includes('qq')" class="chk-row">
              <input type="checkbox" value="qq" v-model="form.channels" class="chk-input" />
              <span class="chk-box">
                <svg v-if="form.channels.includes('qq')" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              QQ
            </label>
            <label v-if="imChannels.includes('wechat')" class="chk-row">
              <input type="checkbox" value="wechat" v-model="form.channels" class="chk-input" />
              <span class="chk-box">
                <svg v-if="form.channels.includes('wechat')" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              微信
            </label>
          </div>
        </div>

        <div v-if="formErr" class="form-err">{{ formErr }}</div>
        <div class="modal-actions">
          <button class="link" @click="showModal = false">取消</button>
          <button class="btn-primary" @click="submit" :disabled="busy">{{ editing ? '保存' : '创建' }}</button>
        </div>
      </div>
    </BaseModal>

    <Transition name="toast">
      <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed, nextTick } from 'vue'
import { scheduledTasksApi } from '@/services/api'
import { fireHint } from '@/composables/useOnboarding'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import BaseModal from '@/components/common/BaseModal.vue'
import { useAuthStore } from '@/stores/auth'
import { PhAlarm } from '@phosphor-icons/vue'

const authStore = useAuthStore()
const imChannels = computed(() => authStore.user?.imChannels ?? [])

const weekdays = ['日', '一', '二', '三', '四', '五', '六']
const tasks = ref([])
const loading = ref(true)
const busy = ref(false)
const showModal = ref(false)
const editing = ref(null)
const formErr = ref('')
const nameRef = ref(null)
const toastMsg = ref('')
let toastTimer = null
function showToast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 2800)
}
const REPEAT_OPTS = [
  { v: 'daily',   label: '每日' },
  { v: 'weekday', label: '工作日' },
  { v: 'weekend', label: '周末' },
  { v: 'custom',  label: '自定义' },
]
const repeatMode      = ref('daily')   // 'daily' | 'weekday' | 'weekend' | 'custom'
const customStartDate = ref('')        // YYYY-MM-DD
const form = reactive({ name: '', payload: '', time: '09:00', channels: ['web'] })

function pad(n) { return String(n).padStart(2, '0') }
function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

watch(repeatMode, (mode) => {
  if (mode === 'custom' && !customStartDate.value) {
    customStartDate.value = todayIso()
  }
})

async function load() {
  loading.value = true
  try {
    const d = await scheduledTasksApi.list()
    tasks.value = d.tasks || []
  } finally { loading.value = false }
}
onMounted(() => { fireHint('schedules'); load() })   // 新手引导：第一次进定时任务页
// 实时：咕咕（web/IM）建/改/删定时任务、或过期任务被 GC 自动清 → 列表实时刷新（不用手动重载）
useLiveRefresh('scheduled_tasks', load)

function blankForm() { return { name: '', payload: '', time: '09:00', channels: ['web'] } }
function openCreate() {
  editing.value = null
  Object.assign(form, blankForm())
  repeatMode.value = 'daily'
  customStartDate.value = ''
  formErr.value = ''
  showModal.value = true
  nextTick(() => nameRef.value?.focus())
}
function filterChannels(chans) {
  const allowed = ['web', ...imChannels.value]
  const filtered = chans.filter(c => allowed.includes(c))
  return filtered.length ? filtered : ['web']
}
function openEdit(t) {
  editing.value = t
  const parsed = parseCron(t.cron)
  repeatMode.value      = parsed.mode
  customStartDate.value = parsed.startDate ?? ''
  const chans = [...new Set([...t.channels].flatMap(c =>
    c === 'chat' ? ['web'] : c === 'im' ? ['feishu', 'qq', 'wechat'] : [c]))]
  Object.assign(form, { name: t.name, payload: t.payload, time: parsed.time, channels: filterChannels(chans) })
  formErr.value = ''
  showModal.value = true
  nextTick(() => nameRef.value?.focus())
}

function buildCron() {
  const [h, m] = form.time.split(':').map(Number)
  if (repeatMode.value === 'custom') {
    const date = customStartDate.value || (() => {
      const now = new Date()
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0)
      if (dt <= now) dt.setDate(dt.getDate() + 1)
      return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
    })()
    return `@once:${date}T${pad(h)}:${pad(m)}`
  }
  const DOW = { daily: '*', weekday: '1-5', weekend: '0,6' }
  return `${m} ${h} * * ${DOW[repeatMode.value] ?? '*'}`
}
function parseCron(cron) {
  cron = cron || ''
  if (cron.startsWith('@once:')) {
    const iso = cron.slice(6)
    const [datePart, timePart] = iso.split('T')
    const [hh, mm] = (timePart ?? '09:00').split(':')
    return { mode: 'custom', time: `${pad(Number(hh))}:${pad(Number(mm))}`, startDate: datePart ?? '' }
  }
  const p = cron.split(' ')
  if (p.length !== 5) return { mode: 'daily', time: '09:00', startDate: '' }
  const [m, h, , , dow] = p
  const time = `${pad(Number(h))}:${pad(Number(m))}`
  const mode = dow === '1-5' || dow === '1,2,3,4,5' ? 'weekday'
             : dow === '0,6' || dow === '6,0'        ? 'weekend'
             : 'daily'
  return { mode, time, startDate: '' }
}
function cronLabel(cron) {
  const p = parseCron(cron)
  if (p.mode === 'custom') {
    return `${p.startDate} ${p.time}`
  }
  const labels = { daily: '每天', weekday: '工作日', weekend: '周末' }
  return `${labels[p.mode] ?? '每天'} ${p.time}`
}
function channelLabel(chs) {
  const map = { web: '通知', chat: '通知', feishu: '飞书', qq: 'QQ', wechat: '微信', im: '飞书/QQ/微信' }
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
  const data = { name: form.name.trim(), payload: form.payload, cron: buildCron(), channels: [...form.channels], enabled: editing.value ? editing.value.enabled : true }
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
  try { const r = await scheduledTasksApi.run(t.id); showToast(r.msg || '已执行一次'); await load() }
  catch (e) { showToast('执行失败：' + (e?.message || '')) }
  finally { busy.value = false }
}
async function removeTask(t) {
  if (!confirm(`删除「${t.name}」？`)) return
  try { await scheduledTasksApi.delete(t.id); await load() } catch {}
}
</script>

<style scoped>
.sched-page { height: 100%; font-family: var(--font-sans); }

/* 和顶栏「新建项目」按钮一致（同 radius，且不用 squircle，与其圆角形状对齐） */
.btn-primary {
  padding: 8px 16px; border: none; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: rgba(255,255,255,0.95);
  font-size: 13px; font-weight: 500; cursor: pointer; font-family: var(--font-sans);
  display: inline-flex; align-items: center;
  box-shadow: 0 3px 12px rgba(123,127,178,0.3);
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.2s ease-out, opacity 0.2s ease-out;
}
.btn-primary:hover { box-shadow: 0 6px 18px rgba(123,127,178,0.4); opacity: 0.92; }
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
  border-radius: var(--radius-md);   /* 14px，与文件卡 .fc-card 一致（普通圆角，不用 squircle） */
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  padding: 13px 15px; display: flex; flex-direction: column; gap: 7px;
  overflow: hidden;
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.3s ease, background 0.25s ease-out;
}
.task-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to top, rgba(255,255,255,0.08), transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: background 0.3s cubic-bezier(0.34,1.2,0.64,1); pointer-events: none;
}
.task-card > * { position: relative; z-index: 1; }
.task-card:hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
.task-card:hover::after { background: rgba(255,255,255,0.2); }
.task-card.off { opacity: 0.5; }
.tc-top { display: flex; align-items: center; gap: 8px; }
.tc-name { font-size: 13px; line-height: 1.2; font-weight: 600; color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

.sched-modal { padding: 16px 18px; }
.divider { height: 1px; background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%); margin: 2px 0 10px; }
.divider-full { margin-left: -18px; margin-right: -18px; background: rgba(0,0,0,0.07); }
/* 任务名放顶部、标题风格（白底描边，学新建项目 field-input） */
.title-input {
  width: 100%; box-sizing: border-box; outline: none;
  font-size: 16px; font-weight: 700; color: var(--text-primary); font-family: var(--font-sans);
  padding: 6px 11px; margin-bottom: 10px;
  border: 1px solid rgba(0,0,0,0.1); border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.72);   /* 与下方字段框统一：0.72 白底 + 0.1 边框 */
  transition: border-color 0.15s, box-shadow 0.15s;
}
.title-input::placeholder { color: rgba(0,0,0,0.28); font-weight: 700; }
.title-input:focus { border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); }
.field { display: block; margin-bottom: 11px; }
.field > span { display: block; font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; }
/* 输入框/选择框：学新建项目（0.72 白底 + rgba(0,0,0,0.1) 边 + 紫色 focus 光圈），曲率连续圆角 */
.field input[type=text], .field input:not([type]), .field textarea, .field select, .field input[type=time] {
  width: 100%; box-sizing: border-box; padding: 8px 11px;
  border: 1px solid rgba(0,0,0,0.1); border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.72);
  font-size: 13px; font-family: var(--font-sans); color: var(--text-primary);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}
.field input:focus, .field textarea:focus, .field select:focus, .field input[type=time]:focus {
  border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1);
}
.field textarea { resize: none; line-height: 1.6; }
/* 重复：preset 选项卡 + 自定义日期范围 */
.repeat-tabs { display: flex; gap: 6px; }
.repeat-tab {
  flex: 1; padding: 7px 0; border-radius: var(--radius-sm);
  border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72);
  font-size: 13px; font-family: var(--font-sans); color: var(--text-secondary);
  cursor: pointer; transition: all 0.15s; text-align: center;
}
.repeat-tab:hover { border-color: rgba(123,127,178,0.4); }
.repeat-tab.on { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: #fff; border-color: transparent; box-shadow: 0 2px 8px rgba(123,127,178,0.3); }
.date-range { margin-top: 8px; }
.time-field input { text-align: center; }
/* 勾选框：登录/注册页同款（隐藏原生 + 自定义方块 + SVG 对勾） */
.chans { display: flex; gap: 18px; }
.chk-row { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; font-size: 13px; color: var(--text-primary); }
.chk-input { display: none; }
.chk-box {
  flex-shrink: 0; width: 16px; height: 16px; border-radius: 5px; corner-shape: squircle;
  border: 1.5px solid rgba(123,127,178,0.35); background: rgba(255,255,255,0.6);
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.chk-input:checked + .chk-box { background: linear-gradient(135deg,#7b7fb2,#9590c4); border-color: transparent; box-shadow: 0 2px 8px rgba(123,127,178,0.35); }
.form-err { color: #d05a5a; font-size: 12px; margin-bottom: 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; align-items: center; margin-top: 6px; }

.toast {
  position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
  background: rgba(30,32,40,0.92); backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
  padding: 10px 20px; font-size: 13px; color: rgba(255,255,255,0.82);
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  pointer-events: none; white-space: nowrap; z-index: 100000;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(8px); }
.toast-leave-to   { opacity: 0; transform: translateX(-50%) translateY(8px); }
</style>
