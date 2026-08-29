<template>
  <div class="sandbox-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">Shell 沙盒</h2>
        <p class="page-desc">管理 Docker 容器沙盒总开关和运行时状态</p>
      </div>
      <button class="btn-primary" :disabled="loading || !canEnable" @click="toggleSandbox">
        {{ loading ? '处理中…' : status.enabled ? '关闭沙盒' : '开启沙盒' }}
      </button>
    </div>

    <section class="section-wrap">
      <div class="section-head">
        <span class="section-label">运行时状态</span>
        <span class="section-desc">Docker、Rootless 和当前 Shell 执行器状态</span>
      </div>
      <div class="panel-card">
      <div class="status-head">
        <div>
          <h3>{{ status.message || '正在读取 Docker 状态' }}</h3>
        </div>
        <span class="status-pill" :class="`status-${status.state}`">{{ stateLabel }}</span>
      </div>
      <div class="status-grid">
        <div><span>Docker CLI</span><strong>{{ status.docker_installed ? '已安装' : '未安装' }}</strong></div>
        <div><span>Docker daemon</span><strong>{{ status.docker_daemon_ready ? '已就绪' : '不可用' }}</strong></div>
        <div><span>Rootless</span><strong>{{ status.rootless === true ? '已启用' : status.rootless === false ? '未启用' : '未知' }}</strong></div>
        <div><span>执行器</span><strong>{{ status.executor_ready ? '可用' : '不可用' }}</strong></div>
      </div>
      <p v-if="!canEnable && !status.enabled" class="status-note">Docker 未安装、daemon、Rootless 或固定镜像未就绪时不能开启沙盒。Shell 不会回退到宿主机执行。</p>
      <p v-if="status.enabled" class="status-note">关闭沙盒只停止容器运行态，不删除用户文件、数据卷或配额。</p>
      </div>
    </section>

    <section class="section-wrap">
      <div class="section-head">
        <span class="section-label">运行配置</span>
        <span class="section-desc">生产沙盒使用固定镜像和 Rootless Docker</span>
      </div>
      <div class="panel-card">
      <div class="config-row"><span>镜像</span><code>{{ status.image }}</code></div>
      <div class="config-row"><span>固定 digest</span><code>{{ status.image_digest || '未配置' }}</code></div>
      <div class="config-row"><span>持久空间配额</span><strong>{{ formatBytes(status.persistent_quota_bytes) }}</strong></div>
      <div class="config-row"><span>临时构建 / cache 配额</span><strong>{{ formatBytes(status.ephemeral_quota_bytes) }}</strong></div>
      <div class="config-row"><span>网络策略</span><strong>{{ status.network_profile === 'none' ? '断网（固定）' : status.network_profile }}</strong></div>
      <div class="config-row config-row-switch">
        <div class="config-row-copy"><span>临时公网访问</span><small>{{ egressHint }}</small></div>
        <ToggleSwitch :model-value="status.network_profile === 'egress'" :disabled="!status.egress_available || egressSaving" aria-label="切换临时公网访问" @update:model-value="toggleEgress" />
      </div>
      <div class="egress-editor">
        <label class="egress-label" for="egress-proxy-url">受控代理地址</label>
        <div class="egress-input-row">
          <input id="egress-proxy-url" v-model="proxyDraft" class="egress-input" type="url" inputmode="url" placeholder="http://egress-proxy:3128" autocomplete="off" />
          <button type="button" class="btn-ghost" :disabled="egressSaving" @click="saveEgressProxy">{{ egressSaving ? '保存中…' : '保存代理' }}</button>
          <button type="button" class="btn-ghost" :disabled="egressTesting || !status.egress_proxy_configured" @click="validateEgressProxy">{{ egressTesting ? '检查中…' : '验证配置' }}</button>
        </div>
        <p class="egress-note">仅接受不含账号密码的 HTTP(S) 地址。验证配置会检查字段、隔离网络和 sandboxd 前置条件；实际连通性仍由 sandboxd 在执行前确认。</p>
        <p v-if="egressMessage" class="action-message" :class="{ error: egressError }">{{ egressMessage }}</p>
      </div>
      <div class="config-row"><span>容器生命周期</span><strong>{{ status.lifecycle_mode === 'ephemeral' ? '单次命令临时容器' : status.lifecycle_mode }}</strong></div>
      <p class="section-note">默认断网。临时公网访问需要隔离 egress 网络、受控代理和每次会话确认；配置不完整时开关不可用。</p>
      <div class="quota-editor">
        <label><span>持久空间（MB）</span><input v-model.number="quotaDraft.persistentMb" type="number" min="64" step="64" /></label>
        <label><span>临时构建 / cache（MB）</span><input v-model.number="quotaDraft.ephemeralMb" type="number" min="64" step="64" /></label>
        <div class="quota-actions"><span v-if="quotaMessage" class="action-message" :class="{ error: quotaError }">{{ quotaMessage }}</span><button type="button" class="btn-ghost" :disabled="quotaSaving" @click="resetQuotaDraft">撤销修改</button><button type="button" class="btn-primary" :disabled="quotaSaving" @click="saveQuotas">{{ quotaSaving ? '保存中…' : '保存配额' }}</button></div>
      </div>
      </div>
    </section>

    <p v-if="error" class="error-message">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { useConfigStore } from '@/stores/config'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'

type SandboxStatus = {
  enabled: boolean
  docker_installed: boolean
  docker_daemon_ready: boolean
  rootless: boolean | null
  image_ready: boolean
  executor_ready: boolean
  state: string
  message: string
  image: string
  image_digest: string
  persistent_quota_bytes: number
  ephemeral_quota_bytes: number
  network_profile: string
  egress_proxy_configured: boolean
  egress_proxy_url: string
  egress_network_ready: boolean
  egress_config_error: string | null
  egress_available: boolean
  egress_enabled: boolean
  lifecycle_mode: string
}

const adminStore = useAdminStore()
const configStore = useConfigStore()
const loading = ref(false)
const error = ref('')
const status = reactive<SandboxStatus>({ enabled: false, docker_installed: false, docker_daemon_ready: false, rootless: null, image_ready: false, executor_ready: false, state: 'unknown', message: '', image: '', image_digest: '', persistent_quota_bytes: 0, ephemeral_quota_bytes: 0, network_profile: 'none', egress_proxy_configured: false, egress_proxy_url: '', egress_network_ready: false, egress_config_error: null, egress_available: false, egress_enabled: false, lifecycle_mode: 'ephemeral' })
const quotaDraft = reactive({ persistentMb: 512, ephemeralMb: 1024 })
const quotaSaving = ref(false)
const quotaMessage = ref('')
const quotaError = ref(false)
const egressSaving = ref(false)
const egressTesting = ref(false)
const proxyDraft = ref('')
const egressMessage = ref('')
const egressError = ref(false)
const canEnable = computed(() => status.docker_installed && status.docker_daemon_ready && status.rootless === true && status.image_ready)
const egressHint = computed(() => {
  if (status.egress_config_error) return status.egress_config_error
  if (!status.egress_proxy_configured) return '尚未配置受控代理'
  if (!status.egress_network_ready) return '隔离网络尚未部署'
  return status.network_profile === 'egress' ? '已启用，会话仍需单独确认' : '可按会话临时启用'
})
const stateLabel = computed(() => ({ ready: '已就绪', disabled: '已关闭', docker_missing: '未安装 Docker', docker_unavailable: 'Docker 不可用', rootless_required: '需要 Rootless', image_unavailable: '镜像未加载' } as Record<string, string>)[status.state] || '未知')
function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
  return `${Math.round(value / (1024 * 1024))} MB`
}
function syncQuotaDraft() {
  quotaDraft.persistentMb = Math.round((configStore.cfg.sandbox.persistent_quota_bytes || status.persistent_quota_bytes) / (1024 * 1024))
  quotaDraft.ephemeralMb = Math.round((configStore.cfg.sandbox.ephemeral_quota_bytes || status.ephemeral_quota_bytes) / (1024 * 1024))
}
function resetQuotaDraft() { syncQuotaDraft(); quotaMessage.value = ''; quotaError.value = false }
async function saveQuotas() {
  quotaSaving.value = true; quotaMessage.value = ''; quotaError.value = false
  try {
    if (quotaDraft.persistentMb < 64 || quotaDraft.ephemeralMb < 64) throw new Error('配额不能低于 64 MB')
    await configStore.saveConfig({ sandbox: { persistent_quota_bytes: quotaDraft.persistentMb * 1024 * 1024, ephemeral_quota_bytes: quotaDraft.ephemeralMb * 1024 * 1024 } })
    await loadStatus()
    syncQuotaDraft()
    quotaMessage.value = '已保存'
  } catch (cause) { quotaError.value = true; quotaMessage.value = cause instanceof Error ? cause.message : String(cause) }
  finally { quotaSaving.value = false }
}
async function toggleEgress(enabled: boolean) {
  egressSaving.value = true
  try {
    await configStore.saveConfig({ sandbox: { network_profile: enabled ? 'egress' : 'none' } })
    await loadStatus()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { egressSaving.value = false }
}

async function saveEgressProxy() {
  egressSaving.value = true
  egressMessage.value = ''
  egressError.value = false
  try {
    const response = await adminStore.authFetch('/api/v1/admin/sandbox/egress/config', {
      method: 'POST',
      body: JSON.stringify({ proxy_url: proxyDraft.value.trim() }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `保存代理失败（${response.status}）`)
    Object.assign(status, body)
    proxyDraft.value = body.egress_proxy_url || ''
    egressMessage.value = '代理配置已保存'
  } catch (cause) {
    egressError.value = true
    egressMessage.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    egressSaving.value = false
  }
}

async function validateEgressProxy() {
  egressTesting.value = true
  egressMessage.value = ''
  egressError.value = false
  try {
    const response = await adminStore.authFetch('/api/v1/admin/sandbox/egress/validate', { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `验证代理失败（${response.status}）`)
    egressMessage.value = body.message || '代理配置有效'
  } catch (cause) {
    egressError.value = true
    egressMessage.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    egressTesting.value = false
  }
}

async function loadStatus() {
  const response = await adminStore.authFetch('/api/v1/admin/sandbox/status')
  if (!response.ok) throw new Error(`读取沙盒状态失败（${response.status}）`)
  Object.assign(status, await response.json())
  proxyDraft.value = status.egress_proxy_url || ''
}

async function toggleSandbox() {
  loading.value = true; error.value = ''
  try {
    const action = status.enabled ? 'disable' : 'enable'
    const response = await adminStore.authFetch(`/api/v1/admin/sandbox/${action}`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `操作失败（${response.status}）`)
    Object.assign(status, body)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { loading.value = false }
}

onMounted(async () => {
  try { await configStore.fetchConfig(); await loadStatus(); syncQuotaDraft() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
})
</script>

<style scoped>
.sandbox-page { min-height: 100%; padding-bottom: 32px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 32px 36px 0; }
.page-title-block { display: flex; flex-direction: column; }
.page-title { margin: 0; color: var(--content-primary); font-size: 22px; font-weight: 700; line-height: 1.2; }
.page-desc { margin-top: 6px; color: var(--content-tertiary); font-size: 12px; }
.btn-primary, .btn-ghost { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex-shrink: 0; min-height: 30px; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 13px; line-height: 1.2; white-space: nowrap; cursor: pointer; }
.btn-primary { margin-top: 1px; border: 0; background: var(--action-primary-bg); color: var(--content-on-accent); font-weight: 600; }
.btn-primary:hover:not(:disabled) { background: var(--action-primary-bg-hover); }
.btn-ghost { border: 1px solid var(--border-subtle); background: var(--surface-glass); color: var(--content-secondary); }
.btn-ghost:hover:not(:disabled) { background: var(--surface-glass-hover); color: var(--content-primary); }
.btn-primary:disabled, .btn-ghost:disabled { cursor: default; opacity: .5; }
.section-wrap { padding: 20px 36px 0; }
.section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.section-label { color: var(--content-primary); font-size: 13px; font-weight: 600; }
.section-desc { color: var(--content-tertiary); font-size: 12px; }
.panel-card { padding: 22px 24px; border: 1px solid var(--panel-glass-border); border-radius: var(--radius-lg); background: var(--panel-glass-bg); box-shadow: var(--elevation-card); color: var(--content-primary); backdrop-filter: var(--panel-glass-blur); -webkit-backdrop-filter: var(--panel-glass-blur); }
.status-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h3 { margin: 0; color: var(--content-primary); font-size: 14px; font-weight: 700; }
.status-pill { flex-shrink: 0; padding: 5px 10px; border-radius: var(--radius-pill); background: var(--surface-muted); color: var(--content-secondary); font-size: 12px; }
.status-ready { background: color-mix(in srgb, var(--status-success) 12%, transparent); color: var(--status-success); }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 20px; }
.status-grid div { padding: 12px; border: 1px solid var(--panel-divider); border-radius: var(--radius-sm); background: var(--surface-glass); }
.status-grid span, .config-row span { display: block; color: var(--content-tertiary); font-size: 12px; }
.status-grid strong { display: block; margin-top: 6px; color: var(--content-primary); font-size: 14px; font-weight: 600; }
.section-note, .status-note { margin: 10px 0 0; color: var(--content-tertiary); font-size: 12px; line-height: 1.6; }
.config-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--panel-divider); }
.config-row:last-of-type { border-bottom: 0; }
.config-row strong { color: var(--content-secondary); font-size: 12px; font-weight: 600; }
.config-row-switch { align-items: center; }
.config-row-copy { min-width: 0; }
.config-row-copy small { display: block; margin-top: 4px; color: var(--content-tertiary); font-size: 11px; line-height: 1.4; }
.config-row code { max-width: 72%; overflow: hidden; color: var(--content-secondary); font-family: var(--font-mono); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.egress-editor { padding: 14px 0 4px; border-bottom: 1px solid var(--panel-divider); }
.egress-label { display: block; margin-bottom: 8px; color: var(--content-secondary); font-size: 12px; font-weight: 600; }
.egress-input-row { display: flex; align-items: center; gap: 8px; }
.egress-input { min-width: 0; flex: 1; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); color: var(--content-primary); font-family: var(--font-mono); font-size: 12px; outline: none; }
.egress-input:focus { border-color: var(--action-primary); box-shadow: var(--control-focus-shadow); }
.egress-note { margin: 8px 0 0; color: var(--content-tertiary); font-size: 11px; line-height: 1.5; }
.quota-editor { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--panel-divider); }
.quota-editor label { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; color: var(--content-secondary); font-size: 12px; }
.quota-editor input { width: 150px; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); color: var(--content-primary); outline: none; }
.quota-editor input:focus { border-color: var(--action-primary); }
.quota-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.action-message { margin-right: auto; color: var(--status-success); font-size: 12px; }
.action-message.error { color: var(--status-danger); }
.error-message { margin: 16px 36px 0; color: var(--status-danger); font-size: 12px; }
@media (max-width: 760px) { .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .page-header { padding-left: 20px; padding-right: 20px; } .section-wrap { padding-left: 20px; padding-right: 20px; } .error-message { margin-left: 20px; margin-right: 20px; } }
@media (max-width: 520px) { .page-header { flex-direction: column; gap: 12px; } .btn-primary { align-self: flex-start; } }
@media (max-width: 620px) { .egress-input-row { align-items: stretch; flex-wrap: wrap; } .egress-input { flex-basis: 100%; } }
</style>
