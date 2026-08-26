<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">工具权限</div>
      <div v-if="loading" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">正在读取权限状态</span></div><div class="pm-static">—</div></div>
      <template v-else>
        <div v-if="globalEnabled" class="pm-tool-rows">
          <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">Shell 沙盒</span><span class="pm-field-hint">允许咕咕在当前会话自动选择的用户沙盒中执行受控命令；绑定工作区时工作区只作为默认目录。</span></div><ToggleSwitch :model-value="prefsStore.shellEnabled" aria-label="切换 Shell 沙盒权限" @update:model-value="prefsStore.saveShellEnabled($event)" /></div>
          <div v-if="systemGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">系统范围 Shell</span><span class="pm-field-hint">允许访问系统范围；请只在明确需要时开启，危险命令仍需确认。</span></div><ToggleSwitch :model-value="prefsStore.shellSystemEnabled" aria-label="切换系统 Shell 权限" @update:model-value="prefsStore.saveShellSystemEnabled($event)" /></div>
          <div v-if="dangerousGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">危险 Shell 命令</span><span class="pm-field-hint">包括删除、覆盖、移动目录，修改权限，以及重启或停止服务等高影响命令；每次具体操作仍需确认。</span></div><ToggleSwitch :model-value="prefsStore.shellDangerousEnabled" aria-label="切换危险 Shell 命令权限" @update:model-value="prefsStore.saveShellDangerousEnabled($event)" /></div>
          <div v-if="autopilotGlobalEnabled" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">Shell Autopilot</span><span class="pm-field-hint">开启后跳过 Shell 确认门；仍受沙盒、配额、超时和审计限制。仅建议在可信环境使用。</span></div><ToggleSwitch :model-value="prefsStore.shellAutopilotEnabled" aria-label="切换 Shell Autopilot" @update:model-value="prefsStore.saveShellAutopilotEnabled($event)" /></div>
        </div>
      </template>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section"><div class="pm-section-label">说明</div><div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-hint">Shell 后端由当前权限自动决定：默认使用用户沙盒；绑定工作区时工作区只作为默认目录；只有同时开启系统权限时才使用系统执行器。管理员或用户未开放对应权限时，Shell 会被禁止。</span></div></div></div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePreferencesStore } from '@/stores/preferences'
import { workspacesApi } from '@/services/api'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
const prefsStore = usePreferencesStore()
const loading = ref(true)
const globalEnabled = ref(false)
const systemGlobalEnabled = ref(false)
const dangerousGlobalEnabled = ref(false)
const autopilotGlobalEnabled = ref(false)
onMounted(async () => { try { const status = await workspacesApi.status(); globalEnabled.value = status.globalEnabled; systemGlobalEnabled.value = status.systemGlobalEnabled; dangerousGlobalEnabled.value = status.dangerousGlobalEnabled; autopilotGlobalEnabled.value = status.autopilotGlobalEnabled === true } finally { loading.value = false } })
</script>

<style>
.pm-tool-rows { display: flex; flex-direction: column; gap: 14px; }
.pm-tool-subhint { display: block; margin-top: -6px; }
</style>
