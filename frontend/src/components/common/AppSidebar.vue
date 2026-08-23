<template>
  <aside class="sidebar">
    <div class="logo">
      <div class="logo-icon">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="M20 7l2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/><path d="M7 18a6 6 0 0 0 3.84-10.61"/>
        </svg>
      </div>
      <span class="logo-text">咕咕</span>
    </div>

    <nav class="nav">
      <div class="nav-divider"></div>
      <div class="nav-section">
        <span class="nav-label">工作台</span>
        <NavItem to="/projects" icon="navigation.projects">项目<template #badge>{{ projectStore.activeCount }}</template></NavItem>
        <NavItem to="/calendar" icon="navigation.calendar">日历</NavItem>
        <NavItem to="/mind" icon="canvas.graph">思维</NavItem>
        <NavItem to="/schedules" icon="admin.alarm">定时任务</NavItem>
      </div>

      <div class="nav-divider"></div>
      <div class="nav-section">
        <span class="nav-label">资源</span>
        <NavItem to="/files" icon="file.folder">文件库</NavItem>
        <div class="nav-item soon-item"><Icon name="communication.customer" class="nav-icon" size="sm" /><span class="nav-label-text">客户</span><span class="soon-badge">咕了</span></div>
        <div class="nav-item soon-item"><Icon name="communication.team" class="nav-icon" size="sm" /><span class="nav-label-text">团队</span><span class="soon-badge">咕了</span></div>
      </div>

      <div class="nav-divider"></div>
      <div class="nav-section">
        <span class="nav-label">通知</span>
        <div class="notif-anchor" ref="notifBtnRef">
          <button class="nav-item notif-btn" :class="{ 'notif-active': notifOpen }" @click.stop="toggleNotif">
            <Icon name="admin.bell" class="nav-icon" size="sm" tone="inherit" /><span class="nav-label-text">通知</span><span v-if="uiStore.notifCount" class="badge">{{ uiStore.notifCount }}</span>
          </button>
        </div>
      </div>
    </nav>

    <div class="user-card" :class="{ open: settingsOpen }" @click.stop="settingsOpen = !settingsOpen">
      <div class="avatar"><img v-if="authStore.user?.avatarUrl" :src="authStore.user.avatarUrl" class="avatar-img" /><template v-else>{{ userInitial }}</template></div>
      <div class="user-info"><div class="user-name">{{ userLabel }}</div></div>
      <div class="theme-mode-quick" role="group" aria-label="主题模式" @click.stop>
        <button
          :title="themeModeTitle"
          aria-label="切换主题模式"
          :aria-pressed="true"
          @click="cycleTheme"
        ><Icon v-if="preference === 'system'" name="theme.system" size="sm" tone="inherit" /><Icon v-else-if="resolved === 'light'" name="theme.light" size="sm" tone="inherit" /><Icon v-else name="theme.dark" size="sm" tone="inherit" /></button>
      </div>

      <Transition name="popup">
        <div v-if="settingsOpen" class="settings-popup" @click.stop>
          <button class="settings-menu-item" @click="feedbackOpen = true; settingsOpen = false"><Icon name="status.info" size="sm" tone="inherit" />提交反馈</button>
          <div class="settings-menu-sep"></div>
          <button class="settings-menu-item" @click="uiStore.openProfile = true; settingsOpen = false"><Icon name="user.default" size="sm" tone="inherit" />个人设置</button>
          <div class="settings-menu-sep"></div>
          <button class="settings-menu-item danger" @click="handleLogout"><Icon name="user.sign-out" size="sm" tone="inherit" />退出登录</button>
        </div>
      </Transition>
    </div>
  </aside>

  <FeedbackModal :show="feedbackOpen" @close="feedbackOpen = false" />

  <Teleport to="body">
    <Transition name="notif-pop">
      <div v-if="notifOpen" class="notif-popup" ref="notifPopupRef" :style="notifStyle" @click.stop>
        <div class="notif-header"><span class="notif-title">通知</span><button class="notif-mark-all" @click="markAllRead">全部已读</button></div>
        <div class="notif-list scroll-surface scroll-surface--compact">
          <div v-for="n in notifications" :key="n.id ?? ''" class="notif-item" :class="{ unread: n.unread }" @click="n.id != null && uiStore.markRead(n.id)">
            <span class="notif-dot" :style="{ background: n.color }"></span>
            <div class="notif-body"><div v-if="n.title" class="notif-msg">{{ n.title }}</div><div class="notif-meta" :class="{ 'as-title': !n.title }"><MarkdownView :text="n.content || n.meta || ''" /></div></div>
            <span v-if="n.unread" class="notif-badge"></span>
          </div>
        </div>
        <div v-if="notifications.length === 0" class="notif-empty">暂无通知</div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import MarkdownView from './MarkdownView.vue'
import { useRouter } from 'vue-router'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useTheme } from '@/composables/useTheme'
import NavItem from './NavItem.vue'
import Icon from '@/components/common/Icon.vue'
import FeedbackModal from './FeedbackModal.vue'

const router = useRouter()
const projectStore = useProjectStore()
const uiStore = useUiStore()
const authStore = useAuthStore()
const { preference, resolved, setTheme } = useTheme()

const userLabel = computed(() => authStore.user?.displayName || authStore.user?.username || '—')
const userInitial = computed(() => (userLabel.value[0] ?? '?').toUpperCase())
const currentModeLabel = computed(() => resolved.value === 'dark' ? '暗色' : '亮色')
const themeModeTitle = computed(() => preference.value === 'system'
  ? `当前显示：${currentModeLabel.value}（跟随系统）`
  : `当前显示：${currentModeLabel.value}，点击切换`)
const feedbackOpen = ref(false)

function cycleTheme() {
  setTheme(preference.value === 'light' ? 'dark' : preference.value === 'dark' ? 'system' : 'light')
}

function handleLogout() { authStore.logout(); router.push('/login') }

const settingsOpen = ref(false)
const notifOpen = ref(false)
const notifBtnRef = ref<HTMLElement | null>(null)
const notifPopupRef = ref<HTMLElement | null>(null)
const notifStyle = ref({})
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
    if (maxHeight < MIN) { top = Math.max(gap, window.innerHeight - gap - MIN); maxHeight = window.innerHeight - top - gap }
    notifStyle.value = { position:'fixed', top:top+'px', left:(rect.right+10)+'px', width:'300px', maxHeight:maxHeight+'px', zIndex:1000 }
  })
}
function markAllRead() { uiStore.markAllRead() }
function closeAll(e: MouseEvent) {
  if ((e?.target as HTMLElement | null)?.closest?.('.nb-stack')) return
  settingsOpen.value = false
  if (notifPopupRef.value && !notifPopupRef.value.contains(e?.target as Node) && !notifBtnRef.value?.contains(e?.target as Node)) notifOpen.value = false
}
onMounted(() => document.addEventListener('click', closeAll))
onUnmounted(() => document.removeEventListener('click', closeAll))
</script>

<style scoped>
.sidebar { width:var(--sidebar-width); height:100vh; flex-shrink:0; background:rgba(255,255,255,.42); backdrop-filter:var(--popup-blur); -webkit-backdrop-filter:var(--popup-blur); border-right:1px solid rgba(255,255,255,.62); box-shadow:inset -1px 0 0 rgba(255,255,255,.65); display:flex; flex-direction:column; padding:24px 14px; position:relative; z-index:40; }
.logo { display:flex; align-items:center; justify-content:center; gap:10px; padding:0 8px; margin-bottom:20px; }
.logo-icon { width:34px; height:34px; border-radius:10px; background:linear-gradient(135deg,#7b7fb2,#c4afc8); display:flex; align-items:center; justify-content:center; color:white; box-shadow:inset 0 1px 0 rgba(255,255,255,.4); }
.logo-text { font-size:16px; font-weight:700; }
.nav { flex:1; display:flex; flex-direction:column; gap:2px; overflow-y:auto; margin-right:-14px; padding-right:14px; scrollbar-gutter:auto; }
.nav-section { display:flex; flex-direction:column; gap:2px; }
.nav-divider { height:1px; background:var(--divider-line); margin:6px 4px; flex-shrink:0; }
.nav-label { font-size:10px; font-weight:600; color:#6e7289; text-transform:uppercase; letter-spacing:.08em; padding:0 10px; margin-bottom:4px; }
.notif-anchor { position:relative; }
.notif-btn { width:100%; display:flex; align-items:center; gap:9px; padding:10px 12px; border-radius:var(--radius-sm); font-size:14px; font-family:var(--font-sans); color:#767980; background:none; border:1px solid transparent; cursor:pointer; text-align:left; transition:all .15s; }
.notif-btn:hover { background:rgba(123,127,178,.08); color:var(--text-primary); }
.notif-btn.notif-active { background:rgba(255,255,255,.38); color:#6b6fa0; font-weight:700; border-color:rgba(255,255,255,.62); box-shadow:inset 0 1px 0 rgba(255,255,255,.85); }
.nav-icon { flex-shrink:0; }.nav-label-text { flex:1; }.badge { background:rgba(123,127,178,.42); color:white; font-size:10px; font-weight:700; padding:1px 6px; border-radius:20px; min-width:18px; text-align:center; }
.user-card { position:relative; display:flex; align-items:center; gap:8px; padding:8px; border-radius:var(--radius-md); background:rgba(255,255,255,.44); border:1px solid rgba(255,255,255,.72); box-shadow:inset 0 1px 0 rgba(255,255,255,.95); cursor:pointer; transition:background .15s; margin-top:auto; }
.user-card:hover { background:rgba(255,255,255,.38); }
.avatar { width:32px; height:32px; border-radius:50%; background:linear-gradient(135deg,#7b7fb2,#7ab8c8); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; color:white; flex-shrink:0; overflow:hidden; box-shadow:0 2px 8px rgba(123,127,178,.35); }
.avatar-img { width:100%; height:100%; object-fit:cover; border-radius:50%; }.user-info { flex:1; min-width:0; overflow:hidden; }.user-name { font-size:13px; font-weight:600; line-height:1.5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.theme-mode-quick { flex-shrink:0; display:flex; gap:2px; padding:2px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--surface-soft); }
.theme-mode-quick button { width:22px; height:22px; display:grid; place-items:center; border:0; border-radius:var(--radius-xs); color:var(--content-tertiary); background:transparent; cursor:pointer; transition:color var(--motion-hover-control) var(--motion-ease-standard),background-color var(--motion-hover-control) var(--motion-ease-standard),box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.theme-mode-quick button:hover { color:var(--content-primary); background:var(--surface-soft-hover); }
.theme-mode-quick button.current { color:var(--selection-fg); }
.theme-mode-quick button.active { color:var(--selection-fg); background:var(--surface-raised); box-shadow:var(--elevation-card); }
/* settings-popup 保留原来的纯 translateY 淡入淡出；不要交给通用 popup scale cadence。 */
.popup-enter-active,.popup-leave-active { transition:opacity .15s,transform .15s; }.popup-enter-from,.popup-leave-to { opacity:0; transform:translateY(6px); }
.soon-item { width:100%; display:flex; align-items:center; gap:9px; padding:9px 10px; border-radius:var(--radius-sm); font-size:13px; font-family:var(--font-sans); color:rgba(30,32,40,.28); border:1px solid transparent; cursor:default; pointer-events:none; }.soon-badge { margin-left:auto; font-size:9px; font-weight:600; letter-spacing:.04em; color:rgba(30,32,40,.22); background:rgba(0,0,0,.06); padding:2px 7px; border-radius:20px; flex-shrink:0; }
</style>

<style>
/* Settings menu is not a generic popup-menu. It keeps the historical Aero geometry/paint exactly,
   while theme-refinements.css only remaps --settings-popup-* values for dark/Mono. This makes the
   component the single final-paint owner and prevents generic danger:hover from stacking underneath. */
.settings-popup {
  position:absolute; bottom:calc(100% + 8px); left:0; right:0; z-index:100; overflow:hidden;
  background:var(--settings-popup-bg,rgba(255,255,255,.44));
  border:1px solid var(--settings-popup-border,rgba(255,255,255,.72));
  border-radius:var(--radius-md);
  box-shadow:var(--settings-popup-shadow,inset 0 1px 0 rgba(255,255,255,.95),0 4px 16px rgba(0,0,0,.08));
  user-select:none;
}
.settings-popup .settings-menu-item {
  position:relative; z-index:0;
  display:flex; align-items:center; gap:8px; width:100%;
  padding:9px 12px; border:none; background:transparent; border-radius:0;
  font-size:13px; font-family:'PingFang SC','Segoe UI',sans-serif;
  color:var(--settings-popup-item-fg,#1e2028); cursor:pointer; text-align:left; white-space:nowrap;
}
.settings-popup .settings-menu-item::before {
  content:''; position:absolute; z-index:-1; inset:-3px 0;
  background:var(--settings-popup-hover-bg,rgba(255,255,255,.55));
  opacity:0; pointer-events:none; transition:opacity .15s ease;
}
.settings-popup .settings-menu-item:hover:not(:disabled) { background:transparent; }
.settings-popup .settings-menu-item:hover:not(:disabled)::before { opacity:1; }
.settings-popup .settings-menu-item.danger { color:var(--settings-popup-danger,#c84a4a); }
.settings-popup .settings-menu-item.danger:hover:not(:disabled)::before { background:var(--settings-popup-danger-hover-bg,rgba(200,90,90,.1)); }
.settings-popup .settings-menu-sep { height:1px; background:var(--settings-popup-divider,rgba(0,0,0,.06)); margin:3px 0; }

.notif-popup { background:rgba(255,255,255,.6); backdrop-filter:var(--popup-blur); -webkit-backdrop-filter:var(--popup-blur); border:1px solid rgba(255,255,255,.75); border-radius:10px; box-shadow:0 4px 20px rgba(0,0,0,.1); overflow:hidden; display:flex; flex-direction:column; }
.notif-header { display:flex; align-items:center; justify-content:space-between; padding:13px 14px 10px; border-bottom:1px solid rgba(0,0,0,.06); }.notif-title { font-size:13px; font-weight:700; color:#1e2028; }.notif-mark-all { font-size:11px; font-weight:500; color:var(--text-secondary); background:none; border:none; cursor:pointer; font-family:'PingFang SC','Segoe UI',sans-serif; padding:2px 6px; border-radius:6px; transition:background .12s; }.notif-mark-all:hover { background:rgba(123,127,178,.1); }
.notif-list { padding:6px; display:flex; flex-direction:column; gap:2px; flex:1; min-height:0; overflow-y:auto; }.notif-item { display:flex; align-items:flex-start; gap:10px; padding:9px 10px; border-radius:10px; cursor:pointer; transition:background .12s; position:relative; }.notif-item:hover { background:rgba(123,127,178,.07); }.notif-item.unread { background:rgba(123,127,178,.05); }.notif-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; margin-top:4px; opacity:.8; }.notif-body { flex:1; min-width:0; }.notif-msg { font-size:12px; font-weight:500; color:#1e2028; line-height:1.4; }.notif-item.unread .notif-msg { font-weight:600; }.notif-meta { font-size:11px; color:#8a8fa8; margin-top:3px; line-height:1.55; word-break:break-word; overflow-wrap:break-word; }.notif-meta.as-title { color:#1e2028; font-size:12px; margin-top:0; }.notif-badge { width:7px; height:7px; border-radius:50%; background:#7b7fb2; flex-shrink:0; margin-top:5px; }.notif-empty { padding:24px; text-align:center; font-size:12px; color:#8a8fa8; }
.notif-pop-enter-active { transition:opacity .16s,transform .18s cubic-bezier(.34,1.2,.64,1); }.notif-pop-leave-active { transition:opacity .12s,transform .12s ease-in; }.notif-pop-enter-from { opacity:0; transform:translateX(-8px) scale(.97); }.notif-pop-leave-to { opacity:0; transform:translateX(-6px) scale(.97); }
</style>
