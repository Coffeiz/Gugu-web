<template>
  <Transition name="chat-open">
    <section
      v-if="open"
      class="gugu-chat-mock"
      :class="{ 'is-expanded': expanded }"
      aria-label="GuguChat mock"
    >
      <aside v-if="expanded" class="chat-sidebar">
        <div class="sidebar-brand">
          <span class="brand-bird" aria-hidden="true"><BirdIcon :size="16" /></span>
          <strong>咕咕</strong>
        </div>
        <span class="sidebar-caption">最近对话</span>
        <button class="session active">
          <span class="session-dot" />
          <span><strong>项目安排</strong><small>刚刚</small></span>
        </button>
        <button class="session">
          <span class="session-dot muted" />
          <span><strong>画册进度</strong><small>昨天</small></span>
        </button>
        <button class="session">
          <span class="session-dot muted" />
          <span><strong>本周计划</strong><small>8月13日</small></span>
        </button>
        <div class="sidebar-spacer" />
        <div class="connected-app"><i /> 网页 · 已连接</div>
      </aside>

      <main class="chat-main" :class="{ 'is-expanded': expanded }">
        <header class="chat-header">
          <strong class="chat-title">{{ expanded ? '项目安排' : '咕咕' }}</strong>
          <span class="presence"><i />在线</span>
          <div class="header-actions">
            <button v-if="!expanded" title="展开" @click="expanded = true">
              <PhArrowsOut :size="13" weight="bold" />
            </button>
            <button v-else title="收起" @click="expanded = false">
              <PhArrowsIn :size="14" weight="bold" />
            </button>
            <button title="关闭" @click="$emit('close')"><PhX :size="13" weight="bold" /></button>
          </div>
        </header>

        <div class="messages">
          <div class="day-label">今天 20:48</div>
          <div class="message-row gugu">
            <div class="bubble assistant-bubble">
              我把今天的项目进度整理好了。<strong>「角色设定」</strong>还有 2 个阶段待办，明天下午有一段空档可以继续推进。
            </div>
          </div>
          <div class="message-row user">
            <div class="bubble user-bubble">那把明天下午留给角色设定，其他项目先别动。</div>
          </div>
          <div class="message-row gugu">
            <div class="bubble assistant-bubble">
              好，明天下午只留「角色设定」。
              <div class="tool-result">
                <span class="tool-icon">✓</span>
                <span><strong>日历已更新</strong><small>14:00–17:00 · 角色设定</small></span>
              </div>
            </div>
          </div>
        </div>

        <div class="composer">
          <button class="composer-tool" title="附件"><PhPaperclip :size="15" /></button>
          <div class="composer-input">和咕咕说点什么…</div>
          <button class="composer-tool" title="语音"><PhMicrophone :size="15" /></button>
          <button class="send-btn" title="发送"><PhPaperPlaneRight :size="14" weight="fill" /></button>
        </div>
      </main>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import { h, ref, watch } from 'vue'
import { PhArrowsIn, PhArrowsOut, PhMicrophone, PhPaperclip, PhPaperPlaneRight, PhX } from '@phosphor-icons/vue'

const props = defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()

const expanded = ref(false)
watch(() => props.open, (open) => {
  if (!open) expanded.value = false
})

const BirdIcon = (props: { size?: number }) => h('svg', {
  width: props.size ?? 16,
  height: props.size ?? 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.7',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
}, [
  h('path', { d: 'M16 7h.01' }),
  h('path', { d: 'M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20' }),
  h('path', { d: 'M20 7l2 .5-2 .5' }),
  h('path', { d: 'M10 18v3' }),
  h('path', { d: 'M14 17.75V21' }),
])
</script>

<style scoped>
/* Real GuguChat geometry: one DOM, small/large are inset changes rather than two windows. */
.gugu-chat-mock {
  position: absolute;
  top: calc(100% - 448px);
  right: var(--floating-edge);
  bottom: 88px;
  left: calc(100% - var(--floating-edge) - 360px);
  z-index: 20;
  display: flex;
  overflow: hidden;
  isolation: isolate;
  color: var(--content-primary);
  background: var(--gugu-chat-bg);
  border: 1px solid var(--gugu-chat-border);
  border-radius: var(--gugu-chat-radius);
  box-shadow: var(--gugu-chat-shadow);
  transition:
    top .42s cubic-bezier(.16,1,.3,1),
    left .42s cubic-bezier(.16,1,.3,1),
    right .42s cubic-bezier(.16,1,.3,1),
    bottom .42s cubic-bezier(.16,1,.3,1);
}
.gugu-chat-mock.is-expanded {
  top: 12px;
  right: 12px;
  bottom: 12px;
  left: max(calc(var(--sidebar-width) + 12px), 39%);
}
.gugu-chat-mock::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  border-radius: inherit;
  box-shadow: inset 0 1px 0 var(--gugu-chat-highlight);
}

/* Same open/close motion as the real GuguChat Transition. */
.chat-open-enter-active {
  transition: opacity .22s ease, transform .36s cubic-bezier(.16,1,.3,1) !important;
  transform-origin: right bottom;
}
.chat-open-leave-active {
  transition: opacity .18s ease-in, transform .22s cubic-bezier(.7,0,.84,0) !important;
  transform-origin: right bottom;
}
.chat-open-enter-from,
.chat-open-leave-to { opacity: 0; transform: scale(.78); }

.chat-sidebar {
  width: 174px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-md) var(--space-sm);
  background: var(--surface-soft);
  border-right: 1px solid var(--border-subtle);
}
.sidebar-brand { display: flex; align-items: center; gap: var(--space-sm); padding: 0 var(--space-sm) var(--space-md); }
.brand-bird { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: white; background: var(--gugu-fab-bg); box-shadow: var(--elevation-card); }
.sidebar-brand strong { font-size: var(--font-size-md); font-weight: var(--font-weight-semibold); }
.sidebar-caption { padding: 0 var(--space-sm) var(--space-xs); color: var(--content-tertiary); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
.session {
  width: 100%;
  padding: var(--space-sm);
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--content-secondary);
  background: transparent;
  text-align: left;
  font-family: var(--font-sans);
}
.session.active { color: var(--content-primary); background: var(--selection-bg); border-color: var(--border-subtle); }
.session-dot { width: 7px; height: 7px; margin-top: var(--space-xs); flex-shrink: 0; border-radius: 50%; background: var(--action-primary); }
.session-dot.muted { background: var(--content-disabled); }
.session span:last-child { min-width: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
.session strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session small { color: var(--content-tertiary); font-size: var(--font-size-xs); }
.sidebar-spacer { flex: 1; }
.connected-app { padding: var(--space-sm); color: var(--content-tertiary); font-size: var(--font-size-xs); }
.connected-app i, .presence i { width: 6px; height: 6px; display: inline-block; margin-right: var(--space-xs); border-radius: 50%; background: var(--status-success); }

.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--gugu-chat-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}
.chat-header {
  min-height: 46px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-md) var(--space-md) var(--space-sm);
  border-bottom: 1px solid var(--gugu-chat-header-border);
}
.chat-main.is-expanded .chat-header { min-height: 52px; padding: var(--space-lg) var(--space-xl) var(--space-md); }
.chat-title { font-size: var(--font-size-md); font-weight: var(--font-weight-bold); }
.chat-main.is-expanded .chat-title { font-weight: var(--font-weight-semibold); }
.presence { margin-left: auto; display: inline-flex; align-items: center; color: var(--status-success); font-size: var(--font-size-xs); }
.header-actions { display: flex; gap: var(--space-xs); }
.header-actions button,
.composer-tool {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--content-secondary);
  background: transparent;
  cursor: pointer;
}
.header-actions button:hover,
.composer-tool:hover { color: var(--content-primary); background: var(--surface-soft-hover); }

.messages {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}
.chat-main.is-expanded .messages { padding: var(--space-xl); gap: var(--space-md); }
.day-label { align-self: center; color: var(--content-tertiary); font-size: var(--font-size-xs); }
.message-row { display: flex; align-items: flex-start; }
.message-row.user { justify-content: flex-end; }
.bubble {
  max-width: 88%;
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-body);
}
.chat-main.is-expanded .bubble { max-width: 72%; font-size: var(--font-size-md); }
.assistant-bubble { background: var(--surface-raised); border: 1px solid var(--border-subtle); box-shadow: var(--elevation-card); border-bottom-left-radius: var(--radius-xs); }
.user-bubble { color: var(--content-on-accent); background: var(--action-primary); border-bottom-right-radius: var(--radius-xs); }
.bubble strong { font-weight: var(--font-weight-semibold); }
.tool-result { margin-top: var(--space-sm); display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm); border-radius: var(--radius-sm); color: var(--content-secondary); background: var(--surface-soft); border: 1px solid var(--border-subtle); }
.tool-icon { width: 20px; height: 20px; display: grid; place-items: center; flex-shrink: 0; border-radius: 50%; color: var(--status-success); background: var(--status-success-bg); font-weight: var(--font-weight-bold); }
.tool-result > span:last-child { display: flex; flex-direction: column; gap: var(--space-xs); }
.tool-result small { color: var(--content-tertiary); font-size: var(--font-size-xs); }

.composer {
  margin: 0 var(--space-md) var(--space-md);
  min-height: 46px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  border: 1px solid var(--border-default);
  box-shadow: var(--elevation-card);
}
.chat-main.is-expanded .composer { margin: 0 var(--space-xl) var(--space-xl); }
.composer-input { flex: 1; padding: 0 var(--space-xs); color: var(--content-tertiary); font-size: var(--font-size-sm); }
.send-btn { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: var(--radius-sm); color: var(--content-on-accent); background: var(--action-primary); }

@media (max-width: 900px) {
  .gugu-chat-mock.is-expanded { left: calc(var(--sidebar-width) + 12px); }
  .chat-sidebar { display: none; }
}
@media (max-width: 760px) {
  .gugu-chat-mock,
  .gugu-chat-mock.is-expanded { top: 12px; right: 12px; bottom: 12px; left: 12px; }
}
</style>