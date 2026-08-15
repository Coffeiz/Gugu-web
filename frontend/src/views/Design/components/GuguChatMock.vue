<template>
  <Transition name="mock-chat">
    <section v-if="open" class="gugu-chat-mock" aria-label="GuguChat mock">
      <header class="chat-header">
        <div class="chat-identity">
          <span class="chat-avatar" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="M20 7l2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/>
            </svg>
          </span>
          <div>
            <strong>咕咕</strong>
            <span class="presence"><i />在线</span>
          </div>
        </div>
        <div class="header-actions">
          <button title="展开"><PhArrowsOut :size="14" weight="bold" /></button>
          <button title="关闭" @click="$emit('close')"><PhX :size="14" weight="bold" /></button>
        </div>
      </header>

      <div class="chat-layout">
        <aside class="chat-sidebar">
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

        <main class="chat-main">
          <div class="messages">
            <div class="day-label">今天 20:48</div>
            <div class="message-row gugu">
              <span class="mini-avatar">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="M20 7l2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/>
                </svg>
              </span>
              <div class="bubble assistant-bubble">
                我把今天的项目进度整理好了。<strong>「角色设定」</strong>还有 2 个阶段待办，明天下午有一段空档可以继续推进。
              </div>
            </div>
            <div class="message-row user">
              <div class="bubble user-bubble">那把明天下午留给角色设定，其他项目先别动。</div>
            </div>
            <div class="message-row gugu">
              <span class="mini-avatar">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="M20 7l2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/>
                </svg>
              </span>
              <div class="bubble assistant-bubble">
                好，明天下午只留「角色设定」。这个 mock 使用的窗口、边框、Elevation 和咕咕球都与真实组件共享令牌。
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
      </div>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import { PhArrowsOut, PhMicrophone, PhPaperclip, PhPaperPlaneRight, PhX } from '@phosphor-icons/vue'

defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()
</script>

<style scoped>
.gugu-chat-mock {
  position: absolute;
  right: 22px;
  bottom: 22px;
  width: min(720px, calc(100% - 44px));
  height: min(470px, calc(100% - 44px));
  z-index: 20;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--content-primary);
  background: var(--gugu-chat-bg);
  border: 1px solid var(--gugu-chat-border);
  border-radius: var(--gugu-chat-radius);
  box-shadow: var(--gugu-chat-shadow);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
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
.chat-header {
  height: 54px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--gugu-chat-header-border);
}
.chat-identity { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.chat-avatar, .mini-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--gugu-fab-bg);
  box-shadow: var(--gugu-fab-shadow);
  flex-shrink: 0;
}
.chat-avatar { width: 32px; height: 32px; }
.mini-avatar { width: 25px; height: 25px; margin-top: 2px; }
.chat-identity strong { display: inline-block; font-size: var(--font-size-body); font-weight: var(--font-weight-semibold); }
.presence { margin-left: var(--space-2); color: var(--content-tertiary); font-size: var(--font-size-xs); font-weight: var(--font-weight-regular); }
.presence i, .connected-app i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 4px; background: var(--status-success); }
.header-actions { display: flex; gap: var(--space-1); }
.header-actions button, .composer-tool {
  width: 30px; height: 30px; border: 0; border-radius: var(--radius-sm); display: grid; place-items: center;
  color: var(--content-secondary); background: transparent; cursor: pointer;
}
.header-actions button:hover, .composer-tool:hover { color: var(--content-primary); background: var(--surface-soft-hover); }
.chat-layout { flex: 1; min-height: 0; display: flex; }
.chat-sidebar {
  width: 174px; flex-shrink: 0; display: flex; flex-direction: column; gap: var(--space-1);
  padding: var(--space-3-compact) var(--space-2); background: var(--surface-soft); border-right: 1px solid var(--border-subtle);
}
.sidebar-caption { padding: 0 var(--space-2) var(--space-1); color: var(--content-tertiary); font-size: var(--font-size-micro); font-weight: var(--font-weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
.session {
  width: 100%; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 9px 8px; display: flex; align-items: flex-start; gap: 8px;
  text-align: left; color: var(--content-secondary); background: transparent; cursor: default; font-family: var(--font-sans);
}
.session.active { color: var(--content-primary); background: var(--selection-bg); border-color: var(--border-subtle); }
.session-dot { width: 7px; height: 7px; margin-top: 5px; flex-shrink: 0; border-radius: 50%; background: var(--action-primary); }
.session-dot.muted { background: var(--content-disabled); }
.session span:last-child { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.session strong { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session small { color: var(--content-tertiary); font-size: var(--font-size-micro); }
.sidebar-spacer { flex: 1; }
.connected-app { padding: var(--space-2); color: var(--content-tertiary); font-size: var(--font-size-micro); }
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: color-mix(in srgb,var(--surface-base) 78%,transparent); }
.messages { flex: 1; overflow: hidden; padding: var(--space-5) var(--space-5) var(--space-3-compact); display: flex; flex-direction: column; gap: var(--space-3-compact); }
.day-label { align-self: center; color: var(--content-tertiary); font-size: var(--font-size-micro); }
.message-row { display: flex; align-items: flex-start; gap: var(--space-2); }
.message-row.user { justify-content: flex-end; }
.bubble { max-width: 76%; padding: 9px 11px; border-radius: 13px; font-size: var(--font-size-sm); line-height: var(--line-height-body); }
.assistant-bubble { background: var(--surface-raised); border: 1px solid var(--border-subtle); box-shadow: var(--elevation-card); }
.user-bubble { color: var(--content-on-accent); background: var(--action-primary); }
.bubble strong { font-weight: var(--font-weight-semibold); }
.tool-result { margin-top: var(--space-2); display: flex; align-items: center; gap: var(--space-2); padding: 8px 9px; border-radius: var(--radius-sm); color: var(--content-secondary); background: var(--surface-soft); border: 1px solid var(--border-subtle); }
.tool-icon { width: 20px; height: 20px; display: grid; place-items: center; flex-shrink: 0; border-radius: 50%; color: var(--status-success); background: var(--status-success-bg); font-weight: var(--font-weight-bold); }
.tool-result > span:last-child { display: flex; flex-direction: column; gap: 1px; }
.tool-result small { color: var(--content-tertiary); font-size: var(--font-size-micro); }
.composer { margin: 0 var(--space-3-compact) var(--space-3-compact); min-height: 46px; flex-shrink: 0; display: flex; align-items: center; gap: var(--space-1); padding: 7px; border-radius: var(--radius-md); background: var(--surface-raised); border: 1px solid var(--border-default); box-shadow: var(--elevation-card); }
.composer-input { flex: 1; padding: 0 4px; color: var(--content-tertiary); font-size: var(--font-size-sm); }
.send-btn { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: var(--radius-sm); color: var(--content-on-accent); background: var(--action-primary); }
.mock-chat-enter-active, .mock-chat-leave-active { transition: opacity var(--motion-default) var(--motion-ease-enter), transform var(--motion-default) var(--motion-ease-enter); }
.mock-chat-enter-from, .mock-chat-leave-to { opacity: 0; transform: translateY(10px) scale(.985); }
@media (max-width: 760px) { .chat-sidebar { display: none; } .gugu-chat-mock { width: calc(100% - 24px); right: 12px; bottom: 12px; height: calc(100% - 24px); } .messages { padding: var(--space-3); } }
</style>
