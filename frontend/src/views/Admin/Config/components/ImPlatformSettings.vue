<template>
  <section class="config-card im-platform-card">
    <div class="card-head">
      <div class="card-icon" style="--ic: color-mix(in srgb, var(--status-info) 14%, transparent); --stroke: var(--status-info)">
        <Icon name="communication.chat" size="md" />
      </div>
      <div class="card-title-block">
        <h3>{{ t('configUi.imPlatformsTitle') }}</h3>
        <p>{{ t('configUi.imPlatformsHint') }}</p>
      </div>
    </div>

    <p class="scope-note">{{ t('configUi.imPlatformsEffect') }}</p>

    <div class="platform-list">
      <div v-for="platform in platforms" :key="platform.key" class="platform-row">
        <div class="platform-copy">
          <span class="platform-name">{{ t(platform.label) }}</span>
          <span class="platform-state">{{ modelValue[platform.key] ? t('configUi.enabled') : t('configUi.disabled') }}</span>
        </div>
        <ToggleSwitch
          size="sm"
          :model-value="modelValue[platform.key]"
          :aria-label="t('configUi.toggleImPlatform', { platform: t(platform.label) })"
          @update:model-value="value => update(platform.key, value)"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'

type PlatformKey = 'feishu' | 'qq' | 'wechat' | 'telegram'
type PlatformSettings = Record<PlatformKey, boolean>

const props = defineProps<{ modelValue: PlatformSettings }>()
const emit = defineEmits<{ 'update:modelValue': [value: PlatformSettings] }>()
const { t } = useI18n()

const platforms: Array<{ key: PlatformKey; label: string }> = [
  { key: 'feishu', label: 'configUi.imFeishu' },
  { key: 'qq', label: 'configUi.imQq' },
  { key: 'wechat', label: 'configUi.imWechat' },
  { key: 'telegram', label: 'configUi.imTelegram' },
]

function update(key: PlatformKey, value: boolean) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<style scoped>
.im-platform-card { display: flex; flex-direction: column; gap: 14px; }
.im-platform-card .card-head { display: flex; align-items: center; gap: 13px; margin: 0; }
.im-platform-card .card-icon { width: 38px; height: 38px; border-radius: 11px; background: var(--ic); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.im-platform-card .card-icon :deep(svg) { width: 18px; height: 18px; color: var(--stroke); }
.card-title-block { min-width: 0; flex: 1; }
.card-title-block h3 { margin: 0; color: var(--content-primary); font-size: 14px; font-weight: 700; line-height: 1.4; }
.card-title-block p { margin: 2px 0 0; color: var(--content-secondary); font-size: 12px; line-height: 1.5; }
.scope-note { margin: 0; color: var(--content-secondary); font-size: 12px; line-height: 1.5; }

.platform-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.platform-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 52px;
  padding: 9px 12px;
  border: 1px solid var(--control-border);
  border-radius: var(--control-radius);
  background: var(--control-bg);
}

.platform-copy {
  display: grid;
  gap: 3px;
}

.platform-name {
  color: var(--content-primary);
  font-size: 13px;
  font-weight: 600;
}

.platform-state {
  color: var(--content-tertiary);
  font-size: 12px;
  line-height: 1.4;
}

@media (max-width: 640px) {
  .platform-list { grid-template-columns: 1fr; }
}
</style>
