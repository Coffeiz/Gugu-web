<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">工具权限</div>
      <div v-if="loading" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">正在读取权限状态</span></div><div class="pm-static">—</div></div>
      <template v-else>
        <div v-if="globalEnabled" class="pm-tool-rows">
          <div v-if="workspaceGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">工作区 Shell</span><span class="pm-field-hint">允许咕咕在当前会话绑定的工作区中执行受控命令。</span></div><button class="toggle-switch" :class="{ on: prefsStore.shellEnabled }" type="button" :aria-pressed="prefsStore.shellEnabled" aria-label="切换工作区 Shell 权限" @click="prefsStore.saveShellEnabled(!prefsStore.shellEnabled)"><span class="toggle-knob" /></button></div>
          <div v-if="personalGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">个人目录 Shell</span><span class="pm-field-hint">允许咕咕在你的个人文件目录中工作，不需要绑定工作区。</span></div><button class="toggle-switch" :class="{ on: prefsStore.shellPersonalEnabled }" type="button" :aria-pressed="prefsStore.shellPersonalEnabled" aria-label="切换个人目录 Shell 权限" @click="prefsStore.saveShellPersonalEnabled(!prefsStore.shellPersonalEnabled)"><span class="toggle-knob" /></button></div>
          <div v-if="systemGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">系统范围 Shell</span><span class="pm-field-hint">允许访问系统范围；请只在明确需要时开启，危险命令仍需确认。</span></div><button class="toggle-switch" :class="{ on: prefsStore.shellSystemEnabled }" type="button" :aria-pressed="prefsStore.shellSystemEnabled" aria-label="切换系统 Shell 权限" @click="prefsStore.saveShellSystemEnabled(!prefsStore.shellSystemEnabled)"><span class="toggle-knob" /></button></div>
          <div v-if="dangerousGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">危险 Shell 命令</span><span class="pm-field-hint">包括删除、覆盖、移动目录，修改权限，以及重启或停止服务等高影响命令；每次具体操作仍需确认。</span></div><button class="toggle-switch" :class="{ on: prefsStore.shellDangerousEnabled }" type="button" :aria-pressed="prefsStore.shellDangerousEnabled" aria-label="切换危险 Shell 命令权限" @click="prefsStore.saveShellDangerousEnabled(!prefsStore.shellDangerousEnabled)"><span class="toggle-knob" /></button></div>
        </div>
      </template>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section"><div class="pm-section-label">说明</div><div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-hint">Shell 范围由当前会话自动决定：绑定工作区时使用工作区；未绑定工作区时优先使用系统范围，系统范围不可用时回落到个人目录。管理员或用户未开放对应权限时，Shell 会被禁止。</span></div></div></div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePreferencesStore } from '@/stores/preferences'
import { workspacesApi } from '@/services/api'
const prefsStore = usePreferencesStore()
const loading = ref(true)
const globalEnabled = ref(false)
const workspaceGlobalEnabled = ref(false)
const personalGlobalEnabled = ref(false)
const systemGlobalEnabled = ref(false)
const dangerousGlobalEnabled = ref(false)
onMounted(async () => { try { const status = await workspacesApi.status(); globalEnabled.value = status.globalEnabled; workspaceGlobalEnabled.value = status.workspaceGlobalEnabled; personalGlobalEnabled.value = status.personalGlobalEnabled; systemGlobalEnabled.value = status.systemGlobalEnabled; dangerousGlobalEnabled.value = status.dangerousGlobalEnabled } finally { loading.value = false } })
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
.toggle-switch.disabled { cursor: not-allowed; opacity: .55; }
.pm-tool-rows { display: flex; flex-direction: column; gap: 14px; }
.pm-tool-subhint { display: block; margin-top: -6px; }
</style>
