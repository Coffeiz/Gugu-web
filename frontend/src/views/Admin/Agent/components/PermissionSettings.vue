<template>
  <section class="permission-card config-card">
    <div class="card-head">
      <div class="card-icon">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 2 17 5v4c0 4.3-2.9 7.3-7 9-4.1-1.7-7-4.7-7-9V5l7-3Z" />
          <path d="m7 10 2 2 4-4" />
        </svg>
      </div>
      <div class="card-title-block">
        <h3>权限开放</h3>
        <p>控制用户可使用的 Agent 能力与个性化配置入口。</p>
      </div>
    </div>

    <div class="permission-groups">
      <section class="permission-group">
        <h4>模型与个性化</h4>
        <div class="permission-list">
          <div class="permission-item">
            <div class="permission-label">
              <span>用户 BYOK</span>
              <span class="permission-desc">允许用户使用自己的模型 API Key，凭据由服务端加密保存。</span>
            </div>
            <ToggleSwitch :model-value="byok.enabled === true" aria-label="开放用户 BYOK" @update:model-value="setByokEnabled" />
          </div>

          <div class="permission-item">
            <div class="permission-label">
              <span>人格偏好</span>
              <span class="permission-desc">允许用户在个人设置中填写人格偏好，最多 10000 字，并在下一轮对话生效。</span>
            </div>
            <ToggleSwitch :model-value="agent.personality_preference_enabled !== false" aria-label="开放用户人格偏好" @update:model-value="setPersonalityEnabled" />
          </div>
        </div>
      </section>

      <section class="permission-group">
        <h4>Shell 能力</h4>
        <div class="permission-list">
          <div class="permission-item">
            <div class="permission-label">
              <span>Shell 工具</span>
              <span class="permission-desc">开启后才允许用户使用 Shell；默认执行后端是 Docker 沙盒。</span>
            </div>
            <ToggleSwitch :model-value="agent.shell_enabled === true" aria-label="开放 Shell 工具" @update:model-value="setAgentFlag('shell_enabled', $event)" />
          </div>

          <div class="permission-item">
            <div class="permission-label">
              <span>Shell Autopilot</span>
              <span class="permission-desc">允许用户开启 Autopilot，跳过 Shell 确认门；沙盒与审计仍然生效。</span>
            </div>
            <ToggleSwitch :model-value="agent.shell_autopilot_enabled === true" :disabled="agent.shell_enabled !== true" aria-label="开放 Shell Autopilot" @update:model-value="setAgentFlag('shell_autopilot_enabled', $event)" />
          </div>

          <div class="permission-item">
            <div class="permission-label">
              <span>系统范围 Shell</span>
              <span class="permission-desc">允许访问系统范围，风险最高；建议仅本地管理员使用。</span>
            </div>
            <ToggleSwitch :model-value="agent.shell_system_enabled === true" :disabled="agent.shell_enabled !== true" aria-label="开放系统范围 Shell" @update:model-value="setAgentFlag('shell_system_enabled', $event)" />
          </div>

          <div class="permission-item">
            <div class="permission-label">
              <span>危险 Shell 命令</span>
              <span class="permission-desc">包括删除、覆盖、移动目录、修改权限和服务启停等高影响命令，仍需逐次确认。</span>
            </div>
            <ToggleSwitch :model-value="agent.shell_dangerous_enabled === true" :disabled="agent.shell_enabled !== true" aria-label="开放危险 Shell 命令" @update:model-value="setAgentFlag('shell_dangerous_enabled', $event)" />
          </div>
        </div>
      </section>
    </div>

    <div class="card-actions">
      <span class="save-hint" :class="{ error: !!error }">{{ error || (saved ? '权限设置已保存' : '') }}</span>
      <button type="button" class="btn-ghost" @click="$emit('reset')">撤销修改</button>
      <button type="button" class="btn-primary" :disabled="saving" @click="$emit('save')">{{ saving ? '保存中…' : '保存' }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'

const props = defineProps({
  agent: { type: Object as PropType<Record<string, any>>, required: true },
  byok: { type: Object as PropType<Record<string, any>>, required: true },
  saving: { type: Boolean, default: false },
  saved: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits<{
  save: []
  reset: []
}>()

function setByokEnabled(value: boolean) {
  props.byok.enabled = value
}

function setPersonalityEnabled(value: boolean) {
  props.agent.personality_preference_enabled = value
}

function setAgentFlag(key: string, value: boolean) {
  props.agent[key] = value
}
</script>

<style scoped>
.config-card { background: rgba(255,255,255,0.05); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; padding: 22px 24px; box-shadow: 0 4px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06); }
.card-head { display: flex; align-items: center; gap: 13px; margin-bottom: 20px; }
.card-icon { width: 38px; height: 38px; border-radius: 11px; background: rgba(123,127,178,0.15); color: #7b7fb2; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.card-icon svg { width: 18px; height: 18px; }
.card-title-block { flex: 1; }
.card-title-block h3 { font-size: 14px; font-weight: 700; color: rgba(255,255,255,0.88); }
.card-title-block p { font-size: 12px; color: rgba(255,255,255,0.38); margin-top: 2px; }
.permission-groups { display: flex; flex-direction: column; gap: 22px; }
.permission-group h4 { color: rgba(255,255,255,0.58); font-size: 11px; font-weight: 650; letter-spacing: .02em; margin-bottom: 6px; }
.permission-list { display: flex; flex-direction: column; }
.permission-item { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px 0; border-top: 1px solid rgba(255,255,255,0.07); }
.permission-label { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.permission-label > span:first-child { color: rgba(255,255,255,0.85); font-size: 13px; font-weight: 600; }
.permission-desc { color: rgba(255,255,255,0.38); font-size: 11px; line-height: 1.5; }
.card-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 8px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.07); }
.save-hint { flex: 1; color: #5ab899; font-size: 12px; }
.save-hint.error { color: #e07878; }
.btn-ghost, .btn-primary { border-radius: 8px; padding: 7px 14px; font-size: 12px; cursor: pointer; }
.btn-ghost { border: 1px solid rgba(255,255,255,0.12); background: transparent; color: rgba(255,255,255,0.6); }
.btn-primary { border: 1px solid rgba(123,127,178,0.4); background: rgba(123,127,178,0.7); color: white; }
.btn-primary:disabled { opacity: .55; cursor: default; }
</style>
