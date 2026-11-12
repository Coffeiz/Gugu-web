<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { desktopData, DesktopBridgeError } from './bridge'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { ClientRow, ProjectRow, SandboxStatus } from './bridge'

const projects = ref<ProjectRow[]>([])
const clients = ref<ClientRow[]>([])
const projectName = ref('')
const clientName = ref('')
const busy = ref(false)
const error = ref('')
const connected = ref(false)
const sandbox = ref<SandboxStatus | null>(null)
const sandboxMessage = ref('')
const pendingOperation = ref('')
const PENDING_OPERATION_KEY = 'gugu.desktop.pending-operation'

async function perform(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    if (reason instanceof DesktopBridgeError && reason.code === 'unknown_result' && reason.operationId) {
      pendingOperation.value = reason.operationId
      localStorage.setItem(PENDING_OPERATION_KEY, reason.operationId)
      error.value = `${error.value}。操作标识 ${reason.operationId}，请先查询操作结果`
    }
  }
  finally { busy.value = false }
}

async function refresh() {
  const [projectRows, clientRows] = await Promise.all([desktopData.projects(), desktopData.clients()])
  projects.value = projectRows
  clients.value = clientRows
  connected.value = true
}

async function recoverPendingOperation() {
  if (!pendingOperation.value) return
  const receipt = await desktopData.receipt(pendingOperation.value)
  if (receipt === null) {
    error.value = '暂未找到操作收据，操作状态仍需确认；请刷新数据后再决定下一步'
    return
  }
  pendingOperation.value = ''
  localStorage.removeItem(PENDING_OPERATION_KEY)
  await refresh()
  error.value = '已查询到操作收据，本地数据已刷新'
}

function createProject() {
  return perform(async () => {
    await desktopData.createProject(projectName.value)
    projectName.value = ''
    await refresh()
  })
}

function createClient() {
  return perform(async () => {
    await desktopData.createClient(clientName.value)
    clientName.value = ''
    await refresh()
  })
}

function checkSandbox() {
  return perform(async () => {
    sandboxMessage.value = '正在检测…'
    sandbox.value = await desktopData.sandboxStatus()
    sandboxMessage.value = sandbox.value.reason ?? (sandbox.value.supported ? '已检测到原生隔离能力' : '当前环境未提供原生隔离能力')
  })
}

onMounted(() => perform(async () => {
  pendingOperation.value = localStorage.getItem(PENDING_OPERATION_KEY) ?? ''
  if (pendingOperation.value) await recoverPendingOperation()
  await refresh()
  sandbox.value = await desktopData.sandboxStatus()
}))
</script>

<template>
  <main class="desktop-workbench">
    <header class="desktop-header">
      <div><span class="desktop-eyebrow">咕咕 · 桌面验证版</span><h1>本地工作台</h1><p>项目和联系人保存在当前设备。</p></div>
      <span class="desktop-state">{{ connected ? 'Core 已连接' : '正在连接 Core' }}</span>
    </header>
    <p v-if="error" class="desktop-error" role="alert">{{ error }}</p>
    <ActionButton v-if="pendingOperation" fit variant="secondary" :disabled="busy" @click="perform(recoverPendingOperation)">查询待确认操作</ActionButton>
    <div class="desktop-columns">
      <section class="desktop-panel" aria-labelledby="desktop-projects">
        <h2 id="desktop-projects">项目 <span>{{ projects.length }}</span></h2>
        <form @submit.prevent="createProject">
          <span id="project-name-title" class="sr-only">项目名称</span>
          <input id="project-name" v-model="projectName" class="form-input" aria-labelledby="project-name-title" maxlength="200" placeholder="准备开展的新项目" required :disabled="busy" />
          <ActionButton fit type="submit" :disabled="busy">创建项目</ActionButton>
        </form>
        <ul v-if="projects.length"><li v-for="project in projects" :key="project.id"><span>{{ project.name }}</span><small>v{{ project.version }}</small></li></ul>
        <p v-else class="desktop-empty">从第一个项目开始。</p>
      </section>
      <section class="desktop-panel" aria-labelledby="desktop-clients">
        <h2 id="desktop-clients">联系人 <span>{{ clients.length }}</span></h2>
        <form @submit.prevent="createClient">
          <span id="client-name-title" class="sr-only">联系人名称</span>
          <input id="client-name" v-model="clientName" class="form-input" aria-labelledby="client-name-title" maxlength="200" placeholder="添加一位联系人" required :disabled="busy" />
          <ActionButton fit type="submit" :disabled="busy">添加联系人</ActionButton>
        </form>
        <ul v-if="clients.length"><li v-for="client in clients" :key="client.id"><span>{{ client.name }}</span></li></ul>
        <p v-else class="desktop-empty">这里会保存你的联系人。</p>
      </section>
    </div>
    <section class="desktop-panel desktop-sandbox">
      <div><h2>执行隔离</h2><p>{{ sandbox?.supported ? '已检测到原生隔离能力' : '当前环境未提供原生隔离能力' }}</p><p v-if="sandboxMessage" role="status">{{ sandboxMessage }}</p></div>
      <ActionButton fit variant="secondary" :disabled="busy" @click="checkSandbox">重新检测</ActionButton>
    </section>
    <ActionButton fit variant="secondary" class="desktop-refresh" :disabled="busy" @click="perform(refresh)">{{ busy ? '处理中…' : '刷新本地数据' }}</ActionButton>
  </main>
</template>

<style scoped>
.desktop-workbench { max-width: 1120px; margin: 0 auto; padding: 48px 40px; color: var(--text-primary); }
.desktop-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 36px; }
.desktop-header > div { min-width: 0; }
.desktop-eyebrow, .desktop-state { color: var(--text-secondary); font-size: 13px; }
h1 { margin: 10px 0; font-size: 30px; font-weight: 600; }
h2 { margin: 0 0 20px; font-size: 18px; font-weight: 600; }
h2 span { margin-left: 8px; color: var(--text-secondary); font-size: 13px; }
p { color: var(--text-secondary); line-height: 1.6; }
.desktop-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.desktop-panel { padding: 24px; border: 1px solid var(--content-divider); border-radius: 16px; background: var(--surface-card-solid); min-width: 0; }
form { display: flex; gap: 10px; }
input { min-width: 0; width: 100%; }
button { flex-shrink: 0; }
ul { margin: 20px 0 0; padding: 0; list-style: none; }
li { display: flex; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--content-divider); }
li span { min-width: 0; overflow-wrap: anywhere; }
small, .desktop-empty { color: var(--text-secondary); }
.desktop-sandbox { margin-top: 24px; display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.desktop-sandbox h2 { margin-bottom: 8px; }
.desktop-refresh { margin-top: 20px; }
.desktop-error { padding: 12px 16px; background: var(--control-bg); border: 1px solid var(--status-danger); border-radius: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
@media (max-width: 760px) { .desktop-workbench { padding: 24px 20px; } .desktop-columns { grid-template-columns: 1fr; } }
</style>
