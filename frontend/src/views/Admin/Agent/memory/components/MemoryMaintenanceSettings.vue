<template>
  <section class="config-card">
    <div class="card-head"><div class="card-icon"><Icon name="admin.time" size="sm" /></div><div class="card-title-block"><h3>记忆运行参数</h3><p>控制记忆提炼、保留和压缩周期；日常运行无需频繁调整。</p></div></div>
    <div class="behavior-grid">
      <div class="behavior-item"><div class="behavior-label"><span>记忆系统</span><span class="behavior-desc">开启后 Agent 自动从对话中提炼记忆。</span></div><button type="button" class="toggle-switch" :class="{ on: agentDraft.memory_enabled }" @click="agentDraft.memory_enabled = !agentDraft.memory_enabled"><span class="toggle-knob" /></button></div>
      <div class="behavior-item"><div class="behavior-label"><span>Reflection 触发阈值</span><span class="behavior-desc">每隔多少条消息触发一次记忆整理。</span></div><input v-model.number="agentDraft.reflection_threshold" type="number" min="1" max="100" class="behavior-input" /></div>
      <div class="behavior-item"><div class="behavior-label"><span>Daily 记忆保留天数</span><span class="behavior-desc">超出后压进 memory.md。</span></div><input v-model.number="agentDraft.daily_retention_days" type="number" min="1" max="90" class="behavior-input" /></div>
    </div>
    <div class="card-actions"><span class="save-hint" :class="{ error: !!behaviorError }">{{ behaviorSaved ? '已保存' : behaviorError }}</span><button class="btn-ghost" @click="resetBehavior">撤销修改</button><button class="btn-primary" :disabled="behaviorSaving" @click="saveBehavior">{{ behaviorSaving ? '保存中…' : '保存' }}</button></div>
  </section>
</template>
<script setup lang="ts">
import { onMounted } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useAgentRuntimeConfig } from '../../runtime-config/useAgentRuntimeConfig'
const { configStore, agentDraft, behaviorSaving, behaviorSaved, behaviorError, resetBehavior, saveBehavior } = useAgentRuntimeConfig()
onMounted(async () => { await configStore.fetchConfig(); Object.assign(agentDraft, configStore.cfg.agent) })
</script>
<style scoped>
.config-card{background:var(--panel-glass-bg);border:1px solid var(--panel-glass-border);border-radius:var(--radius-lg);padding:22px 24px;color:var(--content-primary);box-shadow:var(--elevation-card);backdrop-filter:var(--panel-glass-blur);-webkit-backdrop-filter:var(--panel-glass-blur)}.card-head{display:flex;align-items:center;gap:13px;margin-bottom:20px}.card-icon{width:38px;height:38px;border-radius:11px;background:var(--selection-bg);color:var(--action-primary);display:flex;align-items:center;justify-content:center}.card-title-block{flex:1}.card-title-block h3{font-size:14px;font-weight:700}.card-title-block p{margin-top:3px;color:var(--content-tertiary);font-size:12px;line-height:1.5}.behavior-grid{display:flex;flex-direction:column;gap:2px}.behavior-item{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--panel-divider)}.behavior-item:last-child{border-bottom:0}.behavior-label{display:flex;flex-direction:column;gap:3px}.behavior-label>span:first-child{font-size:13px;font-weight:500}.behavior-desc{color:var(--content-tertiary);font-size:12px;line-height:1.5}.behavior-input{width:280px;box-sizing:border-box;padding:7px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:var(--surface-glass);color:var(--content-primary)}.toggle-switch{display:inline-flex;align-items:center;width:42px;height:24px;padding:0;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);background:var(--surface-soft);cursor:pointer}.toggle-switch.on{background:var(--action-primary);border-color:var(--action-primary)}.toggle-knob{width:16px;height:16px;margin:3px;border-radius:50%;background:var(--content-on-accent);transition:transform var(--motion-fast) var(--motion-ease)}.toggle-switch.on .toggle-knob{transform:translateX(18px)}.card-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--panel-divider)}.save-hint{flex:1;color:var(--status-success);font-size:12px}.save-hint.error{color:var(--status-danger)}.btn-ghost,.btn-primary{min-height:30px;padding:6px 14px;border-radius:var(--radius-sm);font-size:13px;cursor:pointer}.btn-ghost{border:1px solid var(--border-subtle);background:var(--surface-glass);color:var(--content-secondary)}.btn-primary{border:0;background:var(--action-primary-bg);color:var(--content-on-accent)}.btn-primary:disabled{opacity:.5}
/* Agent 记忆开关复用 Admin 通用控件 motion contract。 */
.toggle-switch { flex: 0 0 42px; border-color: var(--control-border); background: var(--control-bg); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--content-primary) 8%, transparent); transition: background var(--motion-fast) var(--motion-ease-standard), border-color var(--motion-fast) var(--motion-ease-standard), box-shadow var(--motion-fast) var(--motion-ease-standard); }
.toggle-switch:hover { border-color: var(--control-border-hover); background: var(--control-bg-hover); }
.toggle-switch:focus-visible { outline: none; box-shadow: var(--control-focus-shadow); }
.toggle-knob { width: 18px; height: 18px; margin: 0 0 0 2px; box-shadow: var(--elevation-control, 0 1px 3px color-mix(in srgb, var(--content-primary) 18%, transparent)); transition: transform var(--motion-fast) var(--motion-ease-standard); }
.toggle-switch:disabled { opacity: .5; cursor: default; }
</style>
