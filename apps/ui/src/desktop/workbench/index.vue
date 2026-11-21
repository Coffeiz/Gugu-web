<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { DesktopOnboardingState } from '@gugu/core/desktop'
import type { SandboxStatus } from '@desktop/bridge/bridge'

const { t } = useI18n()

defineProps<{
  connected: boolean
  busy: boolean
  onboarding: DesktopOnboardingState | null
  sandbox: SandboxStatus | null
  sandboxMessage: string
  pendingOperation: string
}>()

const emit = defineEmits<{
  openAppearance: []
  refresh: []
  recover: []
  checkSandbox: []
}>()
</script>

<template>
  <header class="desktop-header">
    <div><span class="desktop-eyebrow">咕咕 · 桌面验证版</span><h1>本地工作台</h1><p>项目和联系人保存在当前设备。</p></div>
    <span class="desktop-state">{{ connected ? 'Core 已连接' : '正在连接 Core' }}</span>
  </header>
  <section class="desktop-panel glass-card desktop-appearance" aria-labelledby="desktop-appearance">
    <h2 id="desktop-appearance" class="section-title">外观</h2>
    <p>Mono · 深浅色跟随系统</p>
    <ActionButton class="appearance-link" fit variant="secondary" @click="emit('openAppearance')">打开偏好设置</ActionButton>
  </section>
  <section v-if="onboarding" class="desktop-panel glass-card desktop-onboarding" aria-labelledby="desktop-onboarding">
    <h2 id="desktop-onboarding" class="section-title">新手引导状态</h2>
    <p v-if="!onboarding.guide.enabled">当前未启用引导。</p>
    <p v-else-if="onboarding.guide.completed_at">引导已完成。</p>
    <p v-else-if="onboarding.guide.dismissed">引导已暂时关闭。</p>
    <p v-else>引导进行中：{{ onboarding.guide.current_step }} · 已完成 {{ onboarding.guide.completed_steps.length }} 步。</p>
  </section>
  <ActionButton v-if="pendingOperation" fit variant="secondary" :disabled="busy" @click="emit('recover')">查询待确认操作</ActionButton>
  <section class="desktop-panel glass-card desktop-sandbox">
    <div><h2 class="section-title">执行隔离</h2><p>{{ sandbox?.supported ? '已检测到原生隔离能力' : '当前环境未提供原生隔离能力' }}</p><p v-if="sandboxMessage" role="status">{{ sandboxMessage }}</p></div>
    <ActionButton fit variant="secondary" :disabled="busy" @click="emit('checkSandbox')">重新检测</ActionButton>
  </section>
  <section class="desktop-panel glass-card desktop-sandbox" aria-labelledby="desktop-loopscope">
    <div>
      <h2 id="desktop-loopscope" class="section-title">{{ t('devHome.tools.loopScope.label') }}</h2>
      <p>{{ t('devHome.tools.loopScope.description') }}</p>
    </div>
    <ActionButton fit variant="secondary" href="http://127.0.0.1:4319/" target="_blank" rel="noopener noreferrer">
      {{ t('devHome.tools.loopScope.openLocal') }}
    </ActionButton>
  </section>
  <ActionButton fit variant="secondary" class="desktop-refresh" :disabled="busy" @click="emit('refresh')">{{ busy ? '处理中…' : '刷新本地数据' }}</ActionButton>
</template>

<style scoped>
.desktop-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 36px; }
.desktop-header > div { min-width: 0; }
.desktop-eyebrow, .desktop-state { color: var(--text-secondary); font-size: 13px; }
h1 { margin: 10px 0; font-size: 30px; font-weight: 600; }
.desktop-panel { min-width: 0; padding: 22px 24px; margin-bottom: 24px; --glass-card-background-hover: var(--glass-card-background); --glass-card-border-hover: var(--glass-card-border); --glass-card-shadow-hover: var(--glass-card-shadow); }
.desktop-panel:has(+ .desktop-panel) { margin-bottom: var(--space-md); }
.desktop-panel > h2 { margin: 0 0 18px; }
.desktop-panel p { color: var(--text-secondary); line-height: 1.6; }
.appearance-link { margin-top: 12px; }
.desktop-sandbox { display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.desktop-sandbox h2 { margin-bottom: 8px; }
.desktop-refresh { margin-top: -4px; }
</style>
