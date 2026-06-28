<template>
  <div class="svc-page">
    <div class="svc-head">
      <div>
        <h2 class="svc-title">服务状态</h2>
        <p class="svc-sub">常驻进程心跳与依赖；可一键重启（kill + systemd 自愈）</p>
      </div>
      <div class="svc-head-right">
        <span class="svc-deps">
          <span class="dep" :class="deps.redis ? 'ok' : 'bad'">Redis {{ deps.redis ? '通' : '断' }}</span>
          <span class="dep" :class="deps.db ? 'ok' : 'bad'">DB {{ deps.db ? '通' : '断' }}</span>
        </span>
        <button class="svc-refresh" @click="load(true)" :disabled="loading">刷新</button>
      </div>
    </div>

    <div v-if="err" class="svc-err">{{ err }}</div>

    <div v-if="queue.length != null" class="svc-queue">
      <span class="q-label">IM 队列</span>
      <span class="q-stat" title="队列里的消息总数（含已缓冲）">
        <b>{{ queue.length }}</b><i>队列长度</i>
      </span>
      <span class="q-stat" :class="{ warn: (queue.lag || 0) > 20 }" title="已进队列、worker 还没取走 —— 真积压，持续 >0 说明 worker 吃不消">
        <b>{{ queue.lag ?? '—' }}</b><i>积压待取</i>
      </span>
      <span class="q-stat" :class="{ warn: (queue.pending || 0) > 10 }" title="worker 取走了还没 ack —— 在处理中，长期偏高说明有卡住的任务">
        <b>{{ queue.pending ?? '—' }}</b><i>处理中</i>
      </span>
    </div>

    <div class="svc-grid">
      <div v-for="s in services" :key="s.name" class="svc-card">
        <div class="svc-card-top">
          <span class="svc-dot" :class="s.status"></span>
          <span class="svc-name">{{ s.label }}</span>
          <span class="svc-status" :class="s.status">{{ statusText(s.status) }}</span>
        </div>

        <div class="svc-meta">
          <div v-if="s.name === 'web'"><span>运行</span>{{ fmtDur(s.uptime_secs) }}</div>
          <div v-else-if="s.last_seen_secs != null"><span>心跳</span>{{ s.last_seen_secs }}s 前</div>
          <div v-if="s.name === 'supervisor'"><span>网关</span>{{ s.extra?.count ?? 0 }} 个</div>
        </div>

        <div v-if="s.name === 'supervisor' && s.extra?.gateways?.length" class="svc-gateways">
          <div v-for="g in s.extra.gateways" :key="g.key" class="svc-gw">
            <span class="svc-gw-plat">{{ g.platform }}</span>
          </div>
        </div>

        <div v-if="s.name === 'worker' && s.extra?.jobs?.length" class="svc-jobs">
          <span class="svc-jobs-count">定时任务 {{ s.extra.jobs.length }} 个</span>
        </div>

        <div class="svc-card-actions">
          <button v-if="s.restartable" class="svc-restart" :disabled="restarting === s.name" @click="restart(s)">
            {{ restarting === s.name ? '重启中…' : '重启' }}
          </button>
          <span v-else class="svc-self">当前进程</span>
        </div>
        <div v-if="msg[s.name]" class="svc-msg" :class="{ bad: !msgOk[s.name] }">{{ msg[s.name] }}</div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { useAdminStore } from '@/stores/admin'

const adminStore = useAdminStore()
const services = ref([])
const deps = ref({ redis: false, db: false })
const queue = ref({})
const loading = ref(false)
const err = ref('')
const restarting = ref('')
const msg = reactive({})
const msgOk = reactive({})
let timer = null

async function load(manual = false) {
  if (manual) loading.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/services')
    if (!res.ok) throw new Error(`加载失败 (${res.status})`)
    const data = await res.json()
    services.value = data.services || []
    deps.value = data.deps || { redis: false, db: false }
    queue.value = data.queue || {}
    err.value = ''
  } catch (e) { err.value = e.message } finally { loading.value = false }
}

async function restart(s) {
  if (!confirm(`重启「${s.label}」？将向进程发送 SIGTERM，由 systemd 自动拉起（开发环境无 systemd 不会自愈）。`)) return
  restarting.value = s.name
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/services/${s.name}/restart`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    msg[s.name] = data.msg || (res.ok ? '已发送' : `失败 (${res.status})`)
    msgOk[s.name] = !!data.ok
  } catch (e) { msg[s.name] = e.message; msgOk[s.name] = false }
  finally {
    restarting.value = ''
    setTimeout(() => load(), 2500)   // 给 systemd 拉起的时间，再刷新
  }
}

function statusText(st) { return st === 'online' ? '在线' : st === 'stale' ? '僵死' : '掉线' }
function fmtDur(s) {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

onMounted(() => { load(); timer = setInterval(() => load(), 5000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.svc-page { padding: 28px 32px; color: rgba(255,255,255,0.9); }
.svc-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
.svc-title { font-size: 18px; font-weight: 700; margin: 0; }
.svc-sub { font-size: 12px; color: rgba(255,255,255,0.4); margin: 4px 0 0; }
.svc-head-right { display: flex; align-items: center; gap: 12px; }
.svc-deps { display: flex; gap: 6px; }
.dep { font-size: 11px; padding: 3px 9px; border-radius: 6px; }
.dep.ok { color: #74c69d; background: rgba(116,198,157,0.12); }
.dep.bad { color: #e08a8a; background: rgba(224,138,138,0.14); }
.svc-refresh {
  font-size: 12px; padding: 5px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.7);
}
.svc-refresh:hover { background: rgba(255,255,255,0.1); }
.svc-err { color: #e08a8a; font-size: 13px; margin-bottom: 12px; }

.svc-queue {
  display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; padding: 12px 18px; margin-bottom: 16px;
}
.q-label { font-size: 12px; color: rgba(255,255,255,0.4); }
.q-stat { display: flex; align-items: baseline; gap: 6px; cursor: help; }
.q-stat b { font-size: 18px; font-weight: 600; color: rgba(255,255,255,0.92); }
.q-stat i { font-size: 11px; font-style: normal; color: rgba(255,255,255,0.4); }
.q-stat.warn b { color: #fbbf24; }
.q-stat.warn i { color: rgba(251,191,36,0.7); }

.svc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.svc-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; padding: 16px 18px;
  display: flex; flex-direction: column;   /* 等高卡片内按钮顶到底部 */
}
.svc-card-top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.svc-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.svc-dot.online { background: #4ade80; box-shadow: 0 0 8px rgba(74,222,128,0.6); }
.svc-dot.stale { background: #fbbf24; box-shadow: 0 0 8px rgba(251,191,36,0.6); }
.svc-dot.offline { background: #f87171; }
.svc-name { font-size: 14px; font-weight: 600; flex: 1; }
.svc-status { font-size: 11px; }
.svc-status.online { color: #4ade80; }
.svc-status.stale { color: #fbbf24; }
.svc-status.offline { color: #f87171; }

.svc-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: rgba(255,255,255,0.7); }
.svc-meta div span { color: rgba(255,255,255,0.35); margin-right: 6px; }

.svc-gateways { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 5px; }
.svc-gw {
  font-size: 10.5px; padding: 2px 7px; border-radius: 5px;
  background: rgba(123,127,178,0.16); color: rgba(180,185,225,0.95);
}


.svc-jobs { margin-top: 10px; }
.svc-jobs-count { font-size: 11px; color: rgba(255,255,255,0.4); }

.svc-card-actions { margin-top: auto; padding-top: 14px; display: flex; justify-content: flex-end; }
.svc-restart {
  font-size: 12px; padding: 5px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(224,138,138,0.3); background: rgba(224,138,138,0.1); color: #e89a9a;
}
.svc-restart:hover:not(:disabled) { background: rgba(224,138,138,0.18); }
.svc-restart:disabled { opacity: 0.5; cursor: default; }
.svc-self { font-size: 11px; color: rgba(255,255,255,0.3); }
.svc-msg { margin-top: 8px; font-size: 11.5px; color: #74c69d; }
.svc-msg.bad { color: #e08a8a; }
</style>
