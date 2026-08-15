<template>
  <Transition name="chat-open">
    <section v-if="open" class="gugu-chat-mock" :class="{ 'is-expanded': expanded }" aria-label="GuguChat mock">
      <aside v-if="expanded" class="chat-sidebar">
        <div class="sidebar-header"><strong>咕咕</strong></div>
        <div class="sidebar-divider" />
        <div class="session-list">
          <span class="sidebar-caption">即时通讯</span>
          <div class="im-platform open">
            <div class="im-head"><PhCaretDown :size="10" weight="bold" /><strong>QQ</strong><span class="online-badge">已接入</span></div>
            <button class="session im-session"><span class="group-tag">群</span><span class="session-copy"><strong>角色讨论群</strong><small>20:48</small></span></button>
          </div>
          <div class="im-platform"><div class="im-head"><PhCaretRight :size="10" weight="bold" /><strong>微信</strong><span class="online-badge">已接入</span></div></div>
          <div class="im-platform"><div class="im-head"><PhCaretRight :size="10" weight="bold" /><strong>飞书</strong><span class="offline-badge">未接入</span></div></div>

          <div class="sidebar-divider group-divider" />
          <span class="sidebar-caption">最近对话</span>
          <button class="session active"><span class="session-copy"><strong>项目安排</strong><small>20:46</small></span></button>
          <button class="session"><span class="session-copy"><strong>画册进度</strong><small>昨天</small></span></button>
          <button class="session"><span class="session-copy"><strong>本周计划</strong><small>8/13</small></span></button>
        </div>
        <div class="sidebar-divider" />
        <div class="new-chat-wrap"><button class="new-chat"><PhPencilSimple :size="13" weight="bold" />新对话</button></div>
      </aside>

      <main class="chat-main" :class="{ 'is-expanded': expanded }">
        <header class="chat-header">
          <strong class="chat-title">{{ expanded ? '项目安排' : '咕咕' }}</strong>
          <span class="presence"><i />在线</span>
          <div class="header-actions">
            <button v-if="!expanded" title="展开" @click="expanded = true"><PhArrowsOut :size="13" weight="bold" /></button>
            <button v-else title="收起" @click="expanded = false"><PhArrowsIn :size="14" weight="bold" /></button>
            <button title="关闭" @click="$emit('close')"><PhX :size="13" weight="bold" /></button>
          </div>
        </header>

        <div class="messages">
          <div class="day-label">今天 20:48</div>
          <div class="message-row ai"><div class="bubble assistant-bubble">我把今天的项目进度整理好了。<strong>「角色设定」</strong>还有 2 个阶段待办，明天下午有一段空档。</div><div class="message-time">20:44</div></div>
          <div class="message-row user"><div class="bubble user-bubble">那把明天下午留给角色设定，其他项目先别动。</div><div class="message-time">20:45</div></div>
          <div class="message-row ai"><div class="bubble assistant-bubble">好，明天下午只留「角色设定」。<div class="tool-result"><span class="tool-icon">✓</span><span><strong>日历已更新</strong><small>14:00–17:00 · 角色设定</small></span></div></div><div class="message-time">20:46</div></div>
        </div>

        <!-- 与真实 GuguChatComposer 一样：底部整条输入区，不再额外套一个浮动圆角卡。 -->
        <div class="composer">
          <button class="composer-tool" title="附件"><PhPaperclip :size="15" /></button>
          <button class="composer-tool" title="语音"><PhMicrophone :size="15" /></button>
          <div class="composer-input">问问项目进度、截止日期…</div>
          <button class="send-btn" title="发送"><PhArrowRight :size="13" weight="bold" /></button>
        </div>
      </main>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { PhArrowRight, PhArrowsIn, PhArrowsOut, PhCaretDown, PhCaretRight, PhMicrophone, PhPaperclip, PhPencilSimple, PhX } from '@phosphor-icons/vue'
const props = defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()
const expanded = ref(false)
watch(() => props.open, open => { if (!open) expanded.value = false })
</script>

<style scoped>
/* Same geometry/state model as useChatWindow: one rounded DOM changes its four insets. */
.gugu-chat-mock {
  position:absolute;
  top:calc(100% - 448px);
  right:var(--floating-edge);
  bottom:88px;
  left:calc(100% - var(--floating-edge) - 360px);
  z-index:20;
  display:flex;
  overflow:hidden;
  isolation:isolate;
  color:var(--content-primary);
  background:var(--gugu-chat-bg);
  background-clip:padding-box;
  border:1px solid var(--gugu-chat-border);
  border-radius:var(--gugu-chat-radius);
  box-shadow:var(--gugu-chat-shadow);
  backdrop-filter:var(--glass-blur);
  -webkit-backdrop-filter:var(--glass-blur);
  transition:top .42s cubic-bezier(.16,1,.3,1),left .42s cubic-bezier(.16,1,.3,1),right .42s cubic-bezier(.16,1,.3,1),bottom .42s cubic-bezier(.16,1,.3,1);
}
.gugu-chat-mock.is-expanded{top:12px;right:12px;bottom:12px;left:max(calc(var(--sidebar-width) + 12px),39%)}
.gugu-chat-mock::after{content:'';position:absolute;inset:0;z-index:30;pointer-events:none;border-radius:inherit;box-shadow:inset 0 1px 0 var(--gugu-chat-highlight),inset 1px 0 0 color-mix(in srgb,var(--gugu-chat-highlight) 52%,transparent)}
.chat-open-enter-active{transition:opacity .22s ease,transform .36s cubic-bezier(.16,1,.3,1)!important;transform-origin:right bottom}.chat-open-leave-active{transition:opacity .18s ease-in,transform .22s cubic-bezier(.7,0,.84,0)!important;transform-origin:right bottom}.chat-open-enter-from,.chat-open-leave-to{opacity:0;transform:scale(.78)}

.chat-sidebar{width:210px;flex-shrink:0;display:flex;flex-direction:column;background:var(--gugu-chat-sidebar-bg);border-right:1px solid var(--gugu-chat-sidebar-border)}
.sidebar-header{min-height:50px;display:flex;align-items:center;justify-content:center;padding:0 var(--space-md)}.sidebar-header strong{font-size:var(--font-size-md)}
.new-chat-wrap{padding:var(--space-sm) var(--space-sm) var(--space-md)}.new-chat{width:100%;height:var(--control-sm);display:flex;align-items:center;justify-content:center;gap:var(--space-xs);border:1px solid var(--border-default);border-radius:var(--radius-sm);color:var(--action-primary);background:color-mix(in srgb,var(--surface-raised) 84%,transparent);box-shadow:var(--elevation-card);font:var(--font-weight-semibold) var(--font-size-sm) var(--font-sans)}
.sidebar-divider{height:1px;margin:0 var(--space-md);background:var(--divider-line)}.group-divider{margin:var(--space-sm) var(--space-xs)}.session-list{flex:1;padding:var(--space-md) var(--space-sm);display:flex;flex-direction:column;gap:var(--space-xs);overflow:hidden}.sidebar-caption{padding:var(--space-xs) var(--space-sm);color:var(--gugu-chat-caption);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);letter-spacing:var(--tracking-label)}
.im-platform{display:flex;flex-direction:column}.im-head{min-height:36px;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm);border-radius:var(--radius-sm);color:var(--content-secondary)}.im-head strong{flex:1;font-size:var(--font-size-sm)}.im-platform.open .im-head{color:var(--content-primary);background:var(--surface-soft)}.online-badge,.offline-badge{padding:2px var(--space-xs);border-radius:var(--radius-xs);font-size:var(--font-size-xs);font-weight:var(--font-weight-medium)}.online-badge{color:var(--status-success);background:var(--status-success-bg)}.offline-badge{color:var(--content-tertiary);background:var(--surface-soft-hover)}
.session{min-height:40px;width:100%;display:flex;align-items:center;gap:var(--space-xs);padding:var(--space-sm);border:1px solid transparent;border-radius:var(--radius-sm);color:var(--content-secondary);background:transparent;text-align:left;font-family:var(--font-sans)}.im-session{margin-left:var(--space-md);width:calc(100% - var(--space-md))}.session.active{color:var(--gugu-chat-session-active-fg);background:var(--gugu-chat-session-active);border-color:var(--sidebar-item-active-border);box-shadow:var(--sidebar-item-active-shadow)}.session-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:var(--space-xs)}.session strong{font-size:var(--font-size-sm);font-weight:var(--font-weight-semibold);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session small{font-size:var(--font-size-xs);color:var(--content-tertiary)}.group-tag{padding:2px var(--space-xs);border-radius:var(--radius-xs);color:var(--selection-fg);background:var(--selection-bg);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold)}

.chat-main{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--gugu-chat-main-bg)}
.chat-header{min-height:48px;display:flex;align-items:center;gap:var(--space-sm);padding:0 var(--space-md);border-bottom:1px solid var(--gugu-chat-header-border);flex-shrink:0}.chat-main.is-expanded .chat-header{min-height:52px;padding:0 var(--space-lg)}.chat-title{font-size:var(--font-size-md);font-weight:var(--font-weight-bold)}.presence{margin-left:auto;display:flex;align-items:center;color:var(--status-success);font-size:var(--font-size-xs)}.presence i{width:6px;height:6px;margin-right:var(--space-xs);border-radius:var(--radius-pill);background:var(--status-success)}.header-actions{display:flex;gap:var(--space-xs)}.header-actions button,.composer-tool{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:var(--radius-sm);color:var(--content-secondary);background:transparent}.header-actions button:hover,.composer-tool:hover{color:var(--content-primary);background:var(--surface-soft-hover)}
.messages{flex:1;min-height:0;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-md);overflow:hidden}.chat-main.is-expanded .messages{padding:var(--space-xl)}.day-label{align-self:center;color:var(--content-tertiary);font-size:var(--font-size-xs)}.message-row{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-xs)}.message-row.user{align-items:flex-end}.bubble{max-width:88%;padding:var(--space-sm) var(--space-md);border-radius:var(--radius-md);font-size:var(--font-size-sm);line-height:var(--line-height-body)}.chat-main.is-expanded .bubble{max-width:72%;font-size:var(--font-size-md)}.assistant-bubble{border:1px solid var(--border-subtle);border-bottom-left-radius:var(--radius-xs);background:var(--gugu-chat-assistant-bg);box-shadow:var(--elevation-card)}.user-bubble{border-bottom-right-radius:var(--radius-xs);color:var(--content-on-accent);background:var(--gugu-chat-user-bg)}.message-time{padding:0 var(--space-xs);font-size:var(--font-size-xs);color:var(--content-tertiary)}.tool-result{margin-top:var(--space-sm);padding:var(--space-sm);display:flex;align-items:center;gap:var(--space-sm);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);color:var(--content-secondary);background:var(--surface-soft)}.tool-icon{width:20px;height:20px;display:grid;place-items:center;border-radius:var(--radius-pill);color:var(--status-success);background:var(--status-success-bg)}.tool-result>span:last-child{display:flex;flex-direction:column;gap:var(--space-xs)}.tool-result small{font-size:var(--font-size-xs);color:var(--content-tertiary)}
.composer{min-height:48px;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border-top:1px solid var(--gugu-chat-header-border);background:var(--gugu-chat-composer-bg);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--border-highlight) 70%,transparent);flex-shrink:0}.composer-input{min-width:0;flex:1;color:var(--content-tertiary);font-size:var(--font-size-sm)}.send-btn{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:var(--radius-sm);color:#fff;background:var(--brand-gradient)}
@media(max-width:900px){.gugu-chat-mock.is-expanded{left:calc(var(--sidebar-width) + 12px)}.chat-sidebar{display:none}}@media(max-width:760px){.gugu-chat-mock,.gugu-chat-mock.is-expanded{top:12px;right:12px;bottom:12px;left:12px}}
</style>
