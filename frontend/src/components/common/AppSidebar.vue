<template>
  <aside class="sidebar">
    <!-- Logo -->
    <div class="logo">
      <div class="logo-icon">✦</div>
      <span class="logo-text">PM Studio</span>
    </div>

    <!-- 导航 -->
    <nav class="nav">
      <div class="nav-section">
        <span class="nav-label">工作台</span>
        <NavItem to="/dashboard" :icon="icons.grid">总览</NavItem>
        <NavItem to="/projects" :icon="icons.list">
          项目
          <template #badge>{{ projectStore.activeCount }}</template>
        </NavItem>
        <NavItem to="/calendar" :icon="icons.calendar">日历</NavItem>
        <div class="nav-item soon-item">
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" v-html="icons.mind" />
          <span class="nav-label-text">思维</span>
          <span class="soon-badge">即将推出</span>
        </div>
      </div>

      <div class="nav-section">
        <span class="nav-label">资源</span>
        <NavItem to="/files" :icon="icons.folder">文件库</NavItem>
        <div class="nav-item soon-item">
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" v-html="icons.users" />
          <span class="nav-label-text">客户</span>
          <span class="soon-badge">即将推出</span>
        </div>
        <div class="nav-item soon-item">
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" v-html="icons.team" />
          <span class="nav-label-text">团队</span>
          <span class="soon-badge">即将推出</span>
        </div>
      </div>

      <div class="nav-section">
        <span class="nav-label">通知</span>
        <!-- 通知按钮：点击弹出小窗，不跳转路由 -->
        <div class="notif-anchor" ref="notifBtnRef">
          <button
            class="nav-item notif-btn"
            :class="{ 'notif-active': notifOpen }"
            @click.stop="toggleNotif"
          >
            <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" v-html="icons.bell" />
            <span class="nav-label-text">通知</span>
            <span v-if="uiStore.notifCount" class="badge">{{ uiStore.notifCount }}</span>
          </button>
        </div>
      </div>
    </nav>

    <!-- 用户卡片 -->
    <div class="user-card" :class="{ open: settingsOpen }" @click.stop="settingsOpen = !settingsOpen">
      <div class="avatar">{{ userInitial }}</div>
      <div class="user-info">
        <div class="user-name">{{ authStore.user?.username ?? '—' }}</div>
      </div>
      <svg v-html="icons.settings" class="settings-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />

      <!-- 设置弹窗 -->
      <Transition name="popup">
        <div v-if="settingsOpen" class="settings-popup" @click.stop>
          <div class="settings-item">
            <svg v-html="icons.profile" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            个人资料
          </div>
          <div class="settings-item" @click="$router.push('/admin/login'); settingsOpen = false">
            <svg v-html="icons.preferences" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            管理后台
          </div>
          <div class="settings-item danger" @click="handleLogout">
            <svg v-html="icons.logout" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            退出登录
          </div>
        </div>
      </Transition>
    </div>
  </aside>

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
              <div class="notif-msg">{{ n.title }}</div>
              <div class="notif-meta">{{ n.meta }}</div>
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
import { useRouter } from 'vue-router'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import NavItem from './NavItem.vue'

const router       = useRouter()
const projectStore = useProjectStore()
const uiStore      = useUiStore()
const authStore    = useAuthStore()

const userInitial = computed(() =>
  (authStore.user?.username?.[0] ?? '?').toUpperCase()
)

function handleLogout() {
  authStore.logout()
  router.push('/login')
}

const settingsOpen  = ref(false)
const notifOpen     = ref(false)
const notifBtnRef   = ref(null)
const notifPopupRef = ref(null)
const notifStyle    = ref({})

const notifications = ref([])

function toggleNotif() {
  if (notifOpen.value) { notifOpen.value = false; return }
  notifOpen.value = true
  nextTick(() => {
    const rect = notifBtnRef.value?.getBoundingClientRect()
    if (!rect) return
    const top = Math.min(rect.top, window.innerHeight - 320)
    notifStyle.value = {
      position: 'fixed',
      top:  top + 'px',
      left: (rect.right + 10) + 'px',
      width: '300px',
      zIndex: 1000,
    }
  })
}

function markAllRead() {
  notifications.value.forEach(n => n.unread = false)
}

function closeAll(e) {
  settingsOpen.value = false
  if (notifPopupRef.value && !notifPopupRef.value.contains(e?.target) && !notifBtnRef.value?.contains(e?.target)) {
    notifOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', closeAll))
onUnmounted(() => document.removeEventListener('click', closeAll))

const icons = {
  grid: `<rect x="1.5" y="1.5" width="5" height="5" rx="1.2"/><rect x="9.5" y="1.5" width="5" height="5" rx="1.2"/><rect x="1.5" y="9.5" width="5" height="5" rx="1.2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1.2"/>`,
  list: `<path d="M2 4h12M2 8h12M2 12h7"/>`,
  calendar: `<rect x="1.5" y="2.5" width="13" height="12" rx="2"/><path d="M5 1v3M11 1v3M1.5 6.5h13"/>`,
  folder: `<path d="M1.5 4.5C1.5 3.4 2.4 2.5 3.5 2.5h3l2 2h5.5c1.1 0 1.5.9 1.5 2v6c0 1.1-.9 2-2 2h-10c-1.1 0-2-.9-2-2v-8z"/>`,
  users: `<circle cx="8" cy="5.5" r="2.5"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/>`,
  team:  `<circle cx="6" cy="5" r="2.5"/><path d="M1 13c0-2.8 2.2-4.5 5-4.5"/><circle cx="12" cy="5" r="2"/><path d="M10.5 9c1.5.3 3 1.4 3 3.5"/>`,
  mind: `<path d="M5.5 3C4 3 2.5 4.2 2.5 6c0 1 .4 1.8 1 2.4V11h5V8.4c.6-.6 1-1.4 1-2.4 0-1.8-1.5-3-3-3z"/><path d="M5.5 3c.3-.8 1-1.5 2-1.5s1.7.7 2 1.5"/><path d="M9.5 6c.6-.4 1.5-.3 2 .5.5.7.3 1.8-.5 2.2"/><path d="M4.5 11h4"/>`,
  bell: `<path d="M8 1.5a5 5 0 015 5v2.5l1 2H2l1-2V6.5a5 5 0 015-5z"/><path d="M6.5 13a1.5 1.5 0 003 0"/>`,
  settings: `<circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/>`,
  profile: `<circle cx="8" cy="6" r="2.5"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/>`,
  preferences: `<circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>`,
  logout: `<path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M10 11l4-4-4-4M14 7H6"/>`,
}
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
  gap: 10px; padding: 0 8px; margin-bottom: 32px;
}
.logo-icon {
  width: 34px; height: 34px; border-radius: 10px;
  background: linear-gradient(135deg, #7b7fb2, #c4afc8);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; color: white; box-shadow: inset 0 1px 0 rgba(255,255,255,0.4);
}
.logo-text { font-size: 16px; font-weight: 700; }

.nav { flex: 1; display: flex; flex-direction: column; gap: 20px; overflow-y: auto; }
.nav-section { display: flex; flex-direction: column; gap: 2px; }
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
  font-weight: 600; border-color: rgba(255,255,255,0.62);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
}
.nav-icon { width: 15px; height: 15px; flex-shrink: 0; }
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
}
.user-info { flex: 1; overflow-x: hidden; }
.user-name { font-size: 13px; font-weight: 600; line-height: 1.5; }
.settings-icon { width: 14px; height: 14px; color: var(--text-secondary); flex-shrink: 0; }

.settings-popup {
  position: absolute; bottom: calc(100% + 8px); left: 0; right: 0;
  background: rgba(245,245,250,0.88);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.7);
  border-radius: var(--radius-md);
  box-shadow: var(--glass-shadow-lg);
  overflow: hidden; z-index: 100;
}
.settings-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; font-size: 13px;
  color: var(--text-secondary); cursor: pointer; transition: background 0.15s;
}
.settings-item svg { width: 14px; height: 14px; opacity: 0.65; }
.settings-item:hover { background: rgba(123,127,178,0.08); color: rgba(30,32,40,0.82); }
.settings-item.danger:hover { background: rgba(176,120,88,0.08); color: var(--color-warning); }

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

<!-- 通知弹窗样式全局（Teleport 到 body） -->
<style>
.notif-popup {
  background: rgba(238,240,246,0.96);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.82); border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 10px 36px rgba(30,40,80,0.14);
  overflow: hidden;
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

.notif-list { padding: 6px; display: flex; flex-direction: column; gap: 2px; }

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
  font-size: 11px; color: #8a8fa8; margin-top: 2px;
}

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
