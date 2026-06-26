<template>
  <aside class="sidebar">
    <!-- Logo -->
    <div class="logo">
      <div class="logo-icon">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 7h.01"/>
          <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>
          <path d="M20 7l2 .5-2 .5"/>
          <path d="M10 18v3"/>
          <path d="M14 17.75V21"/>
          <path d="M7 18a6 6 0 0 0 3.84-10.61"/>
        </svg>
      </div>
      <span class="logo-text">咕咕</span>
    </div>

    <!-- 导航 -->
    <nav class="nav">
      <div class="nav-divider"></div>

      <div class="nav-section">
        <span class="nav-label">工作台</span>
        <!-- 总览暂时隐藏（默认进项目）；保留给未来团队功能，恢复时取消注释 + 恢复路由
        <NavItem to="/dashboard" :icon="PhSquaresFour">总览</NavItem>
        -->
        <NavItem to="/projects" :icon="PhStack">
          项目
          <template #badge>{{ projectStore.activeCount }}</template>
        </NavItem>
        <NavItem to="/calendar" :icon="PhCalendarBlank">日历</NavItem>
        <NavItem to="/schedules" :icon="PhAlarm">定时任务</NavItem>
        <div class="nav-item soon-item">
          <PhGraph class="nav-icon" :size="15" />
          <span class="nav-label-text">思维</span>
          <span class="soon-badge">咕了</span>
        </div>
      </div>

      <div class="nav-divider"></div>

      <div class="nav-section">
        <span class="nav-label">资源</span>
        <NavItem to="/files" :icon="PhFolder">文件库</NavItem>
        <div class="nav-item soon-item">
          <PhAddressBook class="nav-icon" :size="15" />
          <span class="nav-label-text">客户</span>
          <span class="soon-badge">咕了</span>
        </div>
        <div class="nav-item soon-item">
          <PhUsersThree class="nav-icon" :size="15" />
          <span class="nav-label-text">团队</span>
          <span class="soon-badge">咕了</span>
        </div>
      </div>

      <div class="nav-divider"></div>

      <div class="nav-section">
        <span class="nav-label">通知</span>
        <div class="notif-anchor" ref="notifBtnRef">
          <button
            class="nav-item notif-btn"
            :class="{ 'notif-active': notifOpen }"
            @click.stop="toggleNotif"
          >
            <PhBell class="nav-icon" :size="15" />
            <span class="nav-label-text">通知</span>
            <span v-if="uiStore.notifCount" class="badge">{{ uiStore.notifCount }}</span>
          </button>
        </div>
      </div>
    </nav>

    <!-- 用户卡片 -->
    <div class="user-card" :class="{ open: settingsOpen }" @click.stop="settingsOpen = !settingsOpen">
      <div class="avatar">
        <img v-if="authStore.user?.avatarUrl" :src="authStore.user.avatarUrl" class="avatar-img" />
        <template v-else>{{ userInitial }}</template>
      </div>
      <div class="user-info">
        <div class="user-name">{{ userLabel }}</div>
      </div>

      <!-- 设置弹窗 -->
      <Transition name="popup">
        <div v-if="settingsOpen" class="settings-popup" @click.stop>
          <button class="popup-menu-item" @click="feedbackOpen = true; settingsOpen = false">
            <PhFlag :size="13" weight="bold" />
            提交反馈
          </button>
          <div class="popup-menu-sep"></div>
          <button class="popup-menu-item" @click="uiStore.openProfile = true; settingsOpen = false">
            <PhUser :size="13" weight="bold" />
            个人设置
          </button>
          <div class="popup-menu-sep"></div>
          <button class="popup-menu-item danger" @click="handleLogout">
            <PhSignOut :size="13" weight="bold" />
            退出登录
          </button>
        </div>
      </Transition>
    </div>
  </aside>

  <FeedbackModal :show="feedbackOpen" @close="feedbackOpen = false" />

  <!-- 通知弹窗（Teleport，脱离 sidebar 层叠上下文） -->
  <Teleport to="body">
    <Transition name="notif-pop">
      <div
        v-if="notifOpen"
        class="notif-popup"
        ref="notifPopupRef"
        :style="notifStyle"
        @click.stop
      >
        <div class="notif-header">
          <span class="notif-title">通知</span>
          <button class="notif-mark-all" @click="markAllRead">全部已读</button>
        </div>

        <div class="notif-list">
          <div
            v-for="n in notifications"
            :key="n.id"
            class="notif-item"
            :class="{ unread: n.unread }"
            @click="n.unread = false"
          >
            <span class="notif-dot" :style="{ background: n.color }"></span>
            <div class="notif-body">
              <div v-if="n.title" class="notif-msg">{{ n.title }}</div>
              <div class="notif-meta" :class="{ 'as-title': !n.title }"><MarkdownView :text="n.content || n.meta || ''" /></div>
            </div>
            <span v-if="n.unread" class="notif-badge"></span>
          </div>
        </div>

        <div v-if="notifications.length === 0" class="notif-empty">暂无通知</div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import MarkdownView from './MarkdownView.vue'
import { useRouter } from 'vue-router'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import NavItem from './NavItem.vue'
import {
  PhSquaresFour,
  PhStack,
  PhCalendarBlank,
  PhAlarm,
  PhGraph,
  PhFolder,
  PhAddressBook,
  PhUsersThree,
  PhBell,
  PhUser,
  PhSignOut,
  PhFlag,
} from '@phosphor-icons/vue'
import FeedbackModal from './FeedbackModal.vue'

const router       = useRouter()
const projectStore = useProjectStore()
const uiStore      = useUiStore()
const authStore    = useAuthStore()

const userLabel = computed(() => authStore.user?.displayName || authStore.user?.username || '—')
const userInitial = computed(() => (userLabel.value[0] ?? '?').toUpperCase())
const feedbackOpen = ref(false)

function handleLogout() {
  authStore.logout()
  router.push('/login')
}

const settingsOpen  = ref(false)
const notifOpen     = ref(false)
const notifBtnRef   = ref(null)
const notifPopupRef = ref(null)
const notifStyle    = ref({})

const notifications = computed(() => uiStore.notifications)

function toggleNotif() {
  if (notifOpen.value) { notifOpen.value = false; return }
  notifOpen.value = true
  nextTick(() => {
    const rect = notifBtnRef.value?.getBoundingClientRect()
    if (!rect) return
    const gap = 16, MIN = 240
    let top = rect.top
    let maxHeight = window.innerHeight - top - gap
    if (maxHeight < MIN) {                    // 铃铛太靠下 → 整体上移让出空间
      top = Math.max(gap, window.innerHeight - gap - MIN)
      maxHeight = window.innerHeight - top - gap
    }
    notifStyle.value = {                        // 底部 = top + maxHeight = 视口高 - gap，绝不超出页面
      position: 'fixed',
      top:  top + 'px',
      left: (rect.right + 10) + 'px',
      width: '300px',
      maxHeight: maxHeight + 'px',
      zIndex: 1000,
    }
  })
}

function markAllRead() {
  uiStore.markAllRead()
}

function closeAll(e) {
  // 通知气泡（Teleport 到 body）是独立组件，点它内部（含关闭 ✕）属于气泡自身交互，
  // 不能当成「点击外部」而连带把侧边栏的通知/设置弹窗一起关掉。
  if (e?.target?.closest?.('.nb-stack')) return
  settingsOpen.value = false
  if (notifPopupRef.value && !notifPopupRef.value.contains(e?.target) && !notifBtnRef.value?.contains(e?.target)) {
    notifOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', closeAll))
onUnmounted(() => document.removeEventListener('click', closeAll))
</script>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  height: 100vh; flex-shrink: 0;
  background: rgba(255,255,255,0.42);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border-right: 1px solid rgba(255,255,255,0.62);
  box-shadow: inset -1px 0 0 rgba(255,255,255,0.65);
  display: flex; flex-direction: column;
  padding: 24px 14px; gap: 0;
}

.logo {
  display: flex; align-items: center; justify-content: center;
  gap: 10px; padding: 0 8px; margin-bottom: 20px;
}
.logo-icon {
  width: 34px; height: 34px; border-radius: 10px;
  background: linear-gradient(135deg, #7b7fb2, #c4afc8);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; color: white; box-shadow: inset 0 1px 0 rgba(255,255,255,0.4);
}
.logo-text { font-size: 16px; font-weight: 700; }

.nav { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.nav-section { display: flex; flex-direction: column; gap: 2px; }
.nav-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
  margin: 6px 4px;
  flex-shrink: 0;
}
.nav-label {
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.08em; padding: 0 10px; margin-bottom: 4px;
}

/* 通知按钮 — 复用 NavItem 样式 */
.notif-anchor { position: relative; }
.notif-btn {
  width: 100%; display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border-radius: var(--radius-sm);
  font-size: 13px; font-family: var(--font-sans);
  color: rgba(30,32,40,0.62);
  background: none; border: 1px solid transparent;
  cursor: pointer; text-align: left; transition: all 0.15s;
}
.notif-btn:hover { background: rgba(123,127,178,0.08); color: rgba(30,32,40,0.82); }
.notif-btn.notif-active {
  background: rgba(255,255,255,0.38); color: var(--color-primary);
  font-weight: 700; border-color: rgba(255,255,255,0.62);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
}
.nav-icon { flex-shrink: 0; }
.nav-label-text { flex: 1; }
.badge {
  background: rgba(123,127,178,0.42); color: white;
  font-size: 10px; font-weight: 700; padding: 1px 6px;
  border-radius: 20px; min-width: 18px; text-align: center;
}

/* 用户卡片 */
.user-card {
  position: relative; display: flex; align-items: center; gap: 10px;
  padding: 10px; border-radius: var(--radius-md);
  background: rgba(255,255,255,0.44);
  border: 1px solid rgba(255,255,255,0.72);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95);
  cursor: pointer; transition: background 0.15s; margin-top: auto;
}
.user-card:hover { background: rgba(255,255,255,0.38); }
.avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #7ab8c8);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; color: white; flex-shrink: 0;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(123,127,178,0.35);
}
.avatar-img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.user-info { flex: 1; overflow-x: hidden; }
.user-name { font-size: 13px; font-weight: 600; line-height: 1.5; }
.settings-icon { color: var(--text-secondary); flex-shrink: 0; opacity: 0.6; }

.popup-enter-active, .popup-leave-active { transition: opacity 0.15s, transform 0.15s; }
.popup-enter-from, .popup-leave-to { opacity: 0; transform: translateY(6px); }

.soon-item {
  width: 100%; display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border-radius: var(--radius-sm);
  font-size: 13px; font-family: var(--font-sans);
  color: rgba(30,32,40,0.28);
  border: 1px solid transparent;
  cursor: default;
  pointer-events: none;
}
.soon-badge {
  margin-left: auto;
  font-size: 9px; font-weight: 600; letter-spacing: 0.04em;
  color: rgba(30,32,40,0.22);
  background: rgba(0,0,0,0.06);
  padding: 2px 7px; border-radius: 20px;
  flex-shrink: 0;
}
</style>

<!-- 通知弹窗样式全局（Teleport 到 body）；菜单条目统一沿用 global.css 的 .popup-menu-item -->
<style>
.settings-popup {
  position: absolute; bottom: calc(100% + 8px); left: 0; right: 0;
  z-index: 100; overflow: hidden;
  background: rgba(255,255,255,0.44);
  border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), 0 4px 16px rgba(0,0,0,0.08);
  user-select: none;
}
/* 用户弹窗条目沿用之前的外观（仅作用于 .settings-popup，不影响其它菜单） */
.settings-popup .popup-menu-item {
  padding: 9px 12px; border-radius: 0;
  font-family: 'PingFang SC', 'Segoe UI', sans-serif; color: #1e2028;
}
.settings-popup .popup-menu-item.danger { color: #c84a4a; }
.settings-popup .popup-menu-item:hover:not(:disabled) { background: rgba(255,255,255,0.55); }
.settings-popup .popup-menu-item.danger:hover:not(:disabled) { background: rgba(200,90,90,0.1); }
.settings-popup .popup-menu-sep { background: rgba(0,0,0,0.06); margin: 3px 0; }

.notif-popup {
  /* 与 .popup-menu（右键/排序弹窗）统一外观 */
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.75); border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1);
  overflow: hidden;
  display: flex; flex-direction: column;   /* header 固定 + 列表内部滚动，配合内联 max-height */
}

.notif-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 14px 10px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
}
.notif-title {
  font-size: 13px; font-weight: 700; color: #1e2028;
}
.notif-mark-all {
  font-size: 11px; font-weight: 500; color: #7b7fb2;
  background: none; border: none; cursor: pointer;
  font-family: 'PingFang SC', 'Segoe UI', sans-serif;
  padding: 2px 6px; border-radius: 6px; transition: background 0.12s;
}
.notif-mark-all:hover { background: rgba(123,127,178,0.1); }

.notif-list {
  padding: 6px; display: flex; flex-direction: column; gap: 2px;
  flex: 1; min-height: 0; overflow-y: auto;   /* 在弹窗 max-height 内滚动，不撑出页面 */
}
.notif-list::-webkit-scrollbar { width: 3px; }
.notif-list::-webkit-scrollbar-track { background: transparent; margin: 6px; }
.notif-list::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 99px; }

.notif-item {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 9px 10px; border-radius: 10px; cursor: pointer;
  transition: background 0.12s; position: relative;
}
.notif-item:hover { background: rgba(123,127,178,0.07); }
.notif-item.unread { background: rgba(123,127,178,0.05); }

.notif-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  margin-top: 4px; opacity: 0.8;
}
.notif-body { flex: 1; min-width: 0; }
.notif-msg {
  font-size: 12px; font-weight: 500; color: #1e2028;
  line-height: 1.4;
}
.notif-item.unread .notif-msg { font-weight: 600; }
.notif-meta {
  font-size: 11px; color: #8a8fa8; margin-top: 3px;
  line-height: 1.55; word-break: break-word; overflow-wrap: break-word;
}
/* 无标题时内容即正文：用主文字色、去掉顶部间距，不显得像副标题 */
.notif-meta.as-title { color: #1e2028; font-size: 12px; margin-top: 0; }
/* markdown 排版由通用组件 MarkdownView 统一提供（字号继承自 .notif-meta 的 11px） */

.notif-badge {
  width: 7px; height: 7px; border-radius: 50%;
  background: #7b7fb2; flex-shrink: 0; margin-top: 5px;
}

.notif-empty {
  padding: 24px; text-align: center;
  font-size: 12px; color: #8a8fa8;
}

.notif-pop-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.notif-pop-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.notif-pop-enter-from   { opacity: 0; transform: translateX(-8px) scale(0.97); }
.notif-pop-leave-to     { opacity: 0; transform: translateX(-6px) scale(0.97); }
</style>
