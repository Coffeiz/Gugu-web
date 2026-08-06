<template>
  <div class="exp-sidebar panel-left">
    <div class="exp-sidebar-header">
      <span class="exp-sidebar-title">咕咕</span>
    </div>
    <div class="exp-sidebar-divider"></div>
    <div class="exp-session-list">
      <!-- IM 平台：飞书 / QQ / 微信，可展开抽屉。未接入 → 扫码连接；接入后 → 该平台会话 -->
      <div class="im-plat-group" ref="imGroupElRef" :class="{ 'im-flash': imHighlight }">
      <div v-for="p in imPlatforms" :key="p.key" class="im-plat">
        <button class="im-plat-head" :class="{ open: imOpen[p.key] }" @click="onTogglePlatform(p.key)">
          <svg class="im-plat-chev" :class="{ open: imOpen[p.key] }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
          <span class="im-plat-name">{{ p.label }}</span>
          <span class="im-plat-badge" :class="{ on: botsOf(p.key).length }">{{ botsOf(p.key).length ? '已接入' : '未接入' }}</span>
        </button>
        <div v-show="imOpen[p.key]" class="im-plat-body">
          <!-- 已接入 → 该平台会话抽屉 -->
          <template v-if="botsOf(p.key).length">
            <div v-for="s in imSessionsOf(p.key)" :key="s.id"
              class="exp-session-item" :class="{ active: s.id === sessionId }" @click="onLoadSession(s.id)">
              <span v-if="s.chatType === 'group'" class="exp-session-tag" title="群聊">群</span>
              <span class="exp-session-title">{{ s.title }}</span>
              <button class="exp-session-del" @click.stop="onDeleteSession(s.id)" title="删除"><PhTrash :size="12" weight="bold" /></button>
            </div>
            <div v-if="!imSessionsOf(p.key).length" class="exp-session-empty">暂无对话</div>
          </template>
          <!-- 未接入 → 扫码连接 + 二维码抽屉 -->
          <template v-else>
            <div v-if="connect && connect.platform === p.key" class="im-qr-box">
              <canvas :ref="onSetConnectCanvas" class="im-qr-canvas"></canvas>
              <div class="im-qr-hint">{{ connectHint }}</div>
              <button class="im-qr-cancel" @click="onCancelImConnect">取消</button>
            </div>
            <template v-else>
              <button class="im-connect-btn" :disabled="connecting === p.key" @click="onStartImConnect(p.key)">
                {{ connecting === p.key ? '生成中…' : '扫码连接' }}
              </button>
              <div v-if="connectErr && connecting !== p.key" class="im-qr-err">{{ connectErr }}</div>
            </template>
          </template>
        </div>
      </div>
      </div><!-- /im-plat-group -->

      <!-- 网页对话 -->
      <div v-if="webSessions.length" class="exp-group-divider"></div>
      <div
        v-for="s in webSessions" :key="s.id"
        class="exp-session-item"
        :class="{ active: s.id === sessionId }"
        @click="onLoadSession(s.id)"
      >
        <span class="exp-session-title">{{ s.title }}</span>
        <button class="exp-session-del" @click.stop="onDeleteSession(s.id)" title="删除">
          <PhTrash :size="12" weight="bold" />
        </button>
      </div>
    </div>
    <div class="exp-sidebar-divider" style="margin: 0 12px"></div>
    <div class="exp-new-session-wrap">
      <button class="exp-new-session-btn" @click="onNewSession">
        <PhPencilSimple weight="bold" :size="13" />
        新对话
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 大窗侧边栏：IM 平台抽屉（会话列表/扫码连接）+ 网页会话列表 + 新建会话。
 * 只做展示和事件转发，不持有会话数据或 IM 连接状态本身——这些仍在
 * GuguChat.vue（会话加载与流式紧耦合，IM 扫码连接是跨请求的轮询状态机，
 * 都不适合在这一步单独抽composable，标记为后续独立工作）。
 *
 * imGroupElRef 通过 defineExpose 暴露：offline 状态被点击时
 * （promptConnectIM）要展开侧栏、把这个 IM 分组滚入视口并高亮，
 * 这段一次性的滚动+高亮编排仍由父组件持有。
 */
import { ref, computed, type ComponentPublicInstance } from 'vue'
import { PhTrash, PhPencilSimple } from '@phosphor-icons/vue'
import type { ChatSession, ImPlatformKey } from './chatTypes'

interface ImPlatformOption { key: ImPlatformKey; label: string }
interface ImConnectState { platform: string; id: string | number }

defineProps<{
  imPlatforms: ImPlatformOption[]
  imOpen: Record<ImPlatformKey, boolean>
  imHighlight: boolean
  botsOf: (platform: ImPlatformKey) => unknown[]
  imSessionsOf: (platform: ImPlatformKey) => ChatSession[]
  webSessions: ChatSession[]
  sessionId: number | null
  connect: ImConnectState | null
  connectHint: string
  connectErr: string
  connecting: string
  onTogglePlatform: (key: ImPlatformKey) => void
  onSetConnectCanvas: (el: Element | ComponentPublicInstance | null) => void
  onStartImConnect: (key: ImPlatformKey) => void
  onCancelImConnect: () => void
  onLoadSession: (id: number) => void
  onDeleteSession: (id: number) => void
  onNewSession: () => void
}>()

const imGroupElRef = ref<HTMLElement | null>(null)
defineExpose({ imGroupEl: computed(() => imGroupElRef.value) })
</script>

<style scoped>
.exp-sidebar {
  width: 210px; flex-shrink: 0;
  display: flex; flex-direction: column;
}
.exp-sidebar-header {
  display: flex; align-items: center;
  padding: 16px 14px 12px;
  flex-shrink: 0;
}
.exp-sidebar-divider {
  height: 1px; flex-shrink: 0; margin: 0 4px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
}
.exp-group-divider {
  height: 1px; flex-shrink: 0; margin: 4px 2px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
}
.exp-sidebar-title { flex: 1; font-size: 14px; font-weight: 700; color: var(--text-primary); text-align: center; }

.exp-new-session-wrap {
  padding: 10px 10px 12px;
  flex-shrink: 0;
}
.exp-new-session-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 12.5px; font-weight: 700; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(255,255,255,0.95);
  box-shadow: 0 2px 8px rgba(123,127,178,0.12), inset 0 1px 0 rgba(255,255,255,1);
  transition: background 0.15s, box-shadow 0.15s;
}
.exp-new-session-btn:hover {
  background: rgba(255,255,255,0.95);
  box-shadow: 0 5px 16px rgba(123,127,178,0.22), inset 0 1px 0 rgba(255,255,255,1);
}
.exp-new-session-btn:active {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(123,127,178,0.1), inset 0 1px 0 rgba(255,255,255,1);
  transition: transform 0.05s, box-shadow 0.05s;
}
.exp-new-session-btn svg { display: block; }

.exp-session-list {
  flex: 1; overflow-y: auto;
  padding: 8px;
  display: flex; flex-direction: column; gap: 2px;
}
.exp-session-item {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border-radius: 9px; cursor: pointer;
  transition: background 0.12s;
  flex-shrink: 0;  /* 防止 line-height 调整后被外层 flex column 压扁 */
}
.exp-session-item:hover { background: rgba(255,255,255,0.55); }
.exp-session-item.active { background: rgba(123,127,178,0.12); }
.exp-session-item.active .exp-session-title { font-weight: 700; }
/* 根除中文字体在 line box 内偏上的问题：
   font-size 12.5px + line-height: normal (1.5 = 18.75px) 时，line box 远大于字形
   实际占用，line-edge 规则把字形顶到 line box 顶部，视觉上比 20px 高的删除按钮高 0.7px。
   把 line-height 锁成 17px（≈ 中文字形 ascent+descent 实际占用），line box 装下字形
   不再溢出，字形在 line box 内自然居中。删除按钮 20px 固定居中，line box 17px 居中
   （顶部偏移 9.5px，底部偏移 9.5px），两者中心都对齐到 content area 中心 18px。 */
.exp-session-title {
  flex: 1; font-size: 12.5px; line-height: 17px; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.exp-session-del {
  width: 20px; height: 20px; border-radius: 5px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; transition: opacity 0.12s, background 0.12s; flex-shrink: 0;
}
.exp-session-item:hover .exp-session-del { opacity: 1; }
.exp-session-del:hover { background: rgba(200,80,80,0.1); color: rgba(200,80,80,0.8); }
.exp-session-del svg { display: block; }
.exp-session-empty { font-size: 12px; color: var(--text-secondary); padding: 12px 10px; }
.exp-session-source {
  flex-shrink: 0; font-size: 11px; font-weight: 600; line-height: 1;
  font-family: var(--font-sans); letter-spacing: 0.01em;
  padding: 2px 5px; border-radius: 4px;
}
.exp-session-source.src-qq { background: rgba(18,183,245,0.15); color: #0c8fc0; }
.exp-session-source.src-feishu { background: rgba(66,133,244,0.15); color: #3b6fc4; }
.exp-session-tag {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600; line-height: 1;
  font-family: var(--font-sans);
  padding: 2px 4px; border-radius: 4px;
  background: rgba(123,127,178,0.15); color: #6a6ea3;
}

/* 点击离线后，IM 区短暂高亮一下引导视线（不留痕） */
.im-plat-group { border-radius: 10px; }
.im-plat-group.im-flash { animation: imFlash 2.4s ease-out 1; }
@keyframes imFlash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(123, 127, 178, 0); }
  14%      { box-shadow: 0 0 0 2px rgba(123, 127, 178, 0.55); }
  60%      { box-shadow: 0 0 0 2px rgba(123, 127, 178, 0.28); }
}

/* IM 平台抽屉（飞书 / QQ） */
.im-plat { display: flex; flex-direction: column; }
.im-plat-head {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 10px; border-radius: 9px; border: none; cursor: pointer;
  background: none; font-family: var(--font-sans);
  transition: background 0.12s;
}
.im-plat-head:hover { background: rgba(255,255,255,0.55); }
.im-plat-head.open { background: rgba(123,127,178,0.08); }
.im-plat-chev { color: var(--text-secondary); transition: transform 0.18s ease; flex-shrink: 0; }
.im-plat-chev.open { transform: rotate(-180deg); }
.im-plat-name { flex: 1; text-align: left; font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
.im-plat-badge {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600; line-height: 1;
  padding: 2px 6px; border-radius: 4px;
  background: rgba(123,127,178,0.12); color: var(--text-secondary);
}
.im-plat-badge.on { background: rgba(74,180,120,0.16); color: #2f9e63; }
.im-plat-body {
  display: flex; flex-direction: column; gap: 2px;
  padding: 2px 0 6px;
}
.im-connect-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  margin: 4px 0 2px;
  padding: 9px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 12.5px; font-weight: 700; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(255,255,255,0.95);
  box-shadow: 0 2px 8px rgba(123,127,178,0.12), inset 0 1px 0 rgba(255,255,255,1);
  transition: background 0.15s, box-shadow 0.15s;
}
.im-connect-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.95);
  box-shadow: 0 5px 16px rgba(123,127,178,0.22), inset 0 1px 0 rgba(255,255,255,1);
}
.im-connect-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(123,127,178,0.1), inset 0 1px 0 rgba(255,255,255,1);
  transition: transform 0.05s, box-shadow 0.05s;
}
.im-connect-btn:disabled { opacity: 0.6; cursor: default; }
.im-qr-box {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 12px 8px 10px;
}
.im-qr-canvas {
  width: 160px; height: 160px; border-radius: 10px;
  background: #fff; padding: 6px; box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(123,127,178,0.18);
}
.im-qr-hint { font-size: 11.5px; color: var(--text-secondary); text-align: center; line-height: 1.5; }
.im-qr-err { font-size: 11.5px; color: rgba(200,80,80,0.9); padding: 4px 0; }
.im-qr-cancel {
  font-size: 11.5px; color: var(--text-secondary); background: none; border: none;
  cursor: pointer; padding: 3px 10px; border-radius: 6px; transition: background 0.12s;
}
.im-qr-cancel:hover { background: rgba(123,127,178,0.12); color: var(--text-primary); }
</style>
