<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">工具权限</div>
      <div v-if="loading" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">正在读取权限状态</span></div><div class="pm-static">—</div></div>
      <template v-else>
        <div v-if="!globalEnabled" class="pm-tool-locked"><div class="pm-field-name">Shell 工具</div><div class="pm-field-hint">管理员尚未开启 Shell 工具，你的个人开关暂不可用。</div></div>
        <div v-else class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">Shell 工具</span><span class="pm-field-hint">允许咕咕在你明确绑定的工作区中执行受控命令；新对话默认不会绑定工作区。</span></div><button class="toggle-switch" :class="{ on: prefsStore.shellEnabled }" type="button" :aria-pressed="prefsStore.shellEnabled" aria-label="切换 Shell 工具权限" @click="prefsStore.saveShellEnabled(!prefsStore.shellEnabled)"><span class="toggle-knob" /></button></div>
      </template>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section"><div class="pm-section-label">说明</div><div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-hint">开启个人开关不会自动授权系统目录，也不会自动选择工作区。实际使用还需要会话绑定一个可用工作区。</span></div></div></div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePreferencesStore } from '@/stores/preferences'
import { workspacesApi } from '@/services/api'
const prefsStore = usePreferencesStore()
const loading = ref(true)
const globalEnabled = ref(false)
onMounted(async () => { try { globalEnabled.value = (await workspacesApi.status()).globalEnabled } finally { loading.value = false } })
</script>

<style>
.toggle-switch {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 22px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--content-primary) 18%, transparent);
  border-radius: var(--radius-pill);
  background: var(--switch-track-bg);
  cursor: pointer;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.toggle-switch.on {
  border-color: var(--switch-track-bg-active);
  background: var(--switch-track-bg-active);
}
.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--switch-thumb-bg);
  transition: transform var(--motion-hover-control) var(--motion-ease-standard);
}
.toggle-switch.on .toggle-knob { transform: translateX(16px); }
.toggle-switch:focus-visible { outline: 2px solid var(--action-outline); outline-offset: 2px; }
</style>
