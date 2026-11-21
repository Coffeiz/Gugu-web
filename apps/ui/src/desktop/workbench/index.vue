<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { DesktopOnboardingState } from '@gugu/core/desktop'
import { desktopData } from '@desktop/bridge/bridge'

const { t } = useI18n()

defineProps<{ connected: boolean; busy: boolean }>()
defineEmits<{ openAppearance: []; refresh: [] }>()

const onboarding = ref<DesktopOnboardingState | null>(null)
const onboardingStatus = ref('正在读取…')
const checkingSandbox = ref(false)
const sandboxStatus = ref('')

async function checkSandbox() {
  checkingSandbox.value = true
  sandboxStatus.value = '正在检测…'
  try {
    const sandbox = await desktopData.sandboxStatus()
    sandboxStatus.value = sandbox.reason ?? (sandbox.supported ? '已检测到原生隔离能力' : '当前环境未提供原生隔离能力')
  } catch {
    sandboxStatus.value = '无法检测执行隔离，请重试'
  } finally {
    checkingSandbox.value = false
  }
}

onMounted(async () => {
  void checkSandbox()
  try {
    onboarding.value = await desktopData.onboarding()
    onboardingStatus.value = '暂无引导状态'
  } catch {
    onboardingStatus.value = '无法读取引导状态'
  }
})
</script>

<template>
  <div class="dev-workspace">
    <header class="dev-workspace-header">
      <div>
        <h1>{{ t('navigation.devTools') }}</h1>
        <span class="core-status">{{ connected ? 'Core 已连接' : 'Core 未连接' }}</span>
      </div>
      <ActionButton fit variant="secondary" :disabled="busy" @click="$emit('refresh')">刷新本地数据</ActionButton>
    </header>

    <div class="dev-tool-grid">
      <section class="dev-tool" aria-labelledby="desktop-sandbox">
        <h2 id="desktop-sandbox">执行隔离</h2>
        <p role="status">{{ sandboxStatus }}</p>
        <ActionButton fit variant="secondary" :disabled="checkingSandbox" @click="checkSandbox">重新检测</ActionButton>
      </section>
      <section class="dev-tool" aria-labelledby="desktop-loopscope">
        <h2 id="desktop-loopscope">{{ t('devHome.tools.loopScope.label') }}</h2>
        <p>{{ t('devHome.tools.loopScope.description') }}</p>
        <ActionButton fit variant="secondary" href="http://127.0.0.1:4319/" target="_blank" rel="noopener noreferrer">
          {{ t('devHome.tools.loopScope.openLocal') }}
        </ActionButton>
      </section>
      <section class="dev-tool" aria-labelledby="desktop-onboarding">
        <h2 id="desktop-onboarding">新手引导状态</h2>
        <p v-if="!onboarding">{{ onboardingStatus }}</p>
        <p v-else-if="!onboarding.guide.enabled">当前未启用引导。</p>
        <p v-else-if="onboarding.guide.completed_at">引导已完成。</p>
        <p v-else-if="onboarding.guide.dismissed">引导已暂时关闭。</p>
        <p v-else>引导进行中：{{ onboarding.guide.current_step }} · 已完成 {{ onboarding.guide.completed_steps.length }} 步。</p>
      </section>
      <section class="dev-tool" aria-labelledby="desktop-appearance">
        <h2 id="desktop-appearance">外观</h2>
        <p>Mono · 深浅色跟随系统</p>
        <ActionButton fit variant="secondary" @click="$emit('openAppearance')">打开偏好设置</ActionButton>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dev-workspace {
  max-width: 960px;
  margin-inline: auto;
  padding: clamp(4px, 2vw, 24px);
}
.dev-workspace-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}
.dev-workspace-header h1 {
  margin: 0 0 4px;
  font-size: 24px;
  font-weight: 650;
}
.core-status { color: var(--text-secondary); font-size: 13px; }
.dev-tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: var(--space-sm);
}
.dev-tool {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-sm);
  min-width: 0;
  padding: var(--space-md);
  border: 1px solid var(--content-divider);
  border-radius: var(--radius-md);
  background: var(--surface-card-solid);
}
.dev-tool h2 { margin: 0; font-size: 15px; font-weight: 650; }
.dev-tool p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.dev-tool .app-action-button { margin-top: auto; }
</style>
