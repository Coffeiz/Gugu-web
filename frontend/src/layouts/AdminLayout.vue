<template>
  <div class="admin-layout">
    <aside class="admin-sidebar">
      <!-- 品牌 -->
      <Brand variant="admin" subtitle="管理后台" />

      <div class="sidebar-rule" />

      <!-- 导航 -->
      <nav class="sidebar-nav">
        <div class="nav-group-label">配置</div>
        <div class="nav-item" :class="{ active: isActive('/config') }" role="link" tabindex="0" @click="go('/config')">
          <Icon name="admin.settings" size="sm" />
          系统配置
        </div>
        <div class="nav-item" :class="{ active: isActive('/agent') }" role="link" tabindex="0" @click="go('/agent')">
          <Icon name="admin.robot2" size="sm" />
          Agent 配置
        </div>
        <div class="nav-item nav-sub" :class="{ active: isActive('/agent-behavior') }" role="link" tabindex="0" @click="go('/agent-behavior')"><Icon name="admin.sliders" size="sm" />Agent 能力</div>
        <div class="nav-item nav-sub" :class="{ active: isActive('/agent-memory') }" role="link" tabindex="0" @click="go('/agent-memory')"><Icon name="admin.brain" size="sm" />Agent 记忆</div>
        <div class="nav-item nav-sub" :class="{ active: isActive('/agent-usage') }" role="link" tabindex="0" @click="go('/agent-usage')"><Icon name="admin.analytics" size="sm" />Agent 用量</div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">数据</div>
        <div class="nav-item" :class="{ active: isActive('/analytics') }" role="link" tabindex="0" @click="go('/analytics')">
          <Icon name="admin.analytics" size="sm" />
          数据总览
        </div>
        <div class="nav-item" :class="{ active: isActive('/analytics-usage') }" role="link" tabindex="0" @click="go('/analytics-usage')">
          <Icon name="admin.bar-chart" size="sm" />
          使用分析
        </div>
        <div class="nav-item" :class="{ active: isActive('/perception') }" role="link" tabindex="0" @click="go('/perception')">
          <Icon name="admin.brain" size="sm" />
          感知诊断
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">管理</div>
        <div class="nav-item" :class="{ active: isActive('/feedback') }" role="link" tabindex="0" @click="go('/feedback')">
          <Icon name="admin.flag" size="sm" />
          用户反馈
        </div>
        <div class="nav-item" :class="{ active: isActive('/users') }" role="link" tabindex="0" @click="go('/users')">
          <Icon name="communication.team" size="sm" />
          用户管理
        </div>
        <div class="nav-item" :class="{ active: isActive('/quota') }" role="link" tabindex="0" @click="go('/quota')">
          <Icon name="admin.stack" size="sm" />
          配额管理
        </div>
        <div class="nav-item" :class="{ active: isActive('/sandbox') }" role="link" tabindex="0" @click="go('/sandbox')">
          <Icon name="admin.computer" size="sm" />
          Shell 沙盒
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">运维</div>
        <div class="nav-item" :class="{ active: isActive('/services') }" role="link" tabindex="0" @click="go('/services')">
          <Icon name="admin.pulse" size="sm" />
          服务状态
        </div>
        <div class="nav-item" :class="{ active: isActive('/ops') }" role="link" tabindex="0" @click="go('/ops')">
          <Icon name="admin.gauge" size="sm" />
          运维监控
        </div>
        <div class="nav-item" :class="{ active: isActive('/storage-audit') }" role="link" tabindex="0" @click="go('/storage-audit')">
          <Icon name="admin.folder" size="sm" />
          存储对账
        </div>
        <div class="nav-item" :class="{ active: isActive('/storage-monitor') }" role="link" tabindex="0" @click="go('/storage-monitor')">
          <Icon name="admin.analytics" size="sm" />
          存储监控
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">运营</div>
        <div class="nav-item" :class="{ active: isActive('/notifications') }" role="link" tabindex="0" @click="go('/notifications')">
          <Icon name="admin.bell" size="sm" />
          通知发布
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">日志</div>
        <div class="nav-item" :class="{ active: isActive('/audit-log') }" role="link" tabindex="0" @click="go('/audit-log')">
          <Icon name="admin.clipboard" size="sm" />
          操作日志
        </div>
        <div class="nav-item" :class="{ active: isActive('/system-logs') }" role="link" tabindex="0" @click="go('/system-logs')">
          <Icon name="admin.terminal" size="sm" />
          系统日志
        </div>
        <div class="nav-item" :class="{ active: isActive('/debug') }" role="link" tabindex="0" @click="go('/debug')">
          <Icon name="admin.bug" size="sm" />
          Debug 日志
        </div>
      </nav>

      <!-- 底部 -->
      <div class="sidebar-footer">
        <!-- 用户卡片 — 对齐前端 user-card 风格 -->
        <div class="user-card">
          <div class="user-avatar">{{ initial }}</div>
          <div class="user-info">
            <div class="user-name">{{ adminStore.adminUser?.username ?? 'Admin' }}</div>
          </div>
          <button class="logout-btn" title="退出登录" @click="handleLogout">
            <Icon name="user.sign-out" size="sm" />
          </button>
        </div>
      </div>
    </aside>

    <main class="admin-main">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import Brand from '@/components/common/Brand.vue'

const route = useRoute()
const router = useRouter()
const adminStore = useAdminStore()
const initial = computed(() => (adminStore.adminUser?.username?.[0] ?? 'A').toUpperCase())

// 导航：编程式跳转，不渲染 <a href>，悬停时状态栏不暴露 URL
const isActive = (to: string) => route.path === to || route.path.startsWith(to + '/')
function go(to: string) {
  if (route.path !== to) router.push(to)
}
function goHash(to: string, hash: string) {
  if (route.path !== to) {
    router.push({ path: to, hash })
  } else {
    const el = document.querySelector(hash)
    if (el) el.scrollIntoView({ behavior: 'smooth' })
  }
}

function handleLogout() {
  adminStore.logout()
  router.push('/login')
}
</script>

<style scoped>
.admin-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
  font-family: var(--font-sans);
}

/* ── 侧边栏 ── */
.admin-sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--sidebar-bg);
  backdrop-filter: var(--popup-blur);
  -webkit-backdrop-filter: var(--popup-blur);
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--sidebar-border);
  box-shadow: inset -1px 0 0 var(--sidebar-highlight);
  overflow: hidden;
  padding: 24px 14px;
  gap: 0;
}

.sidebar-rule {
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, var(--border-subtle) 30%, var(--border-subtle) 70%, transparent 100%);
  margin: 0 4px;
}

/* ── 导航 ── */
.sidebar-nav {
  flex: 1; padding: 14px 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px;
  margin-right: -14px; padding-right: 14px;   /* 延伸到侧边栏右边缘，滚动条贴边 */
  /* 滚动条由全局浮层契约统一管理，不为它预留布局空间。 */
}
.nav-sub { padding-left: 28px; font-size: 12px; color: var(--content-muted); }
/* 出现滚动条时，flex column 会把 1px 高的分割线（及其它子项）压缩至 0 使其消失——
   固定不收缩，让溢出交给滚动而非挤压内容。 */
.sidebar-nav > * { flex-shrink: 0; }
.nav-group-label {
  font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
  color: var(--content-muted); text-transform: uppercase;
  padding: 0 10px; margin-bottom: 4px;
}
.nav-item {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border-radius: var(--radius-sm);
  font-size: var(--font-size-md); color: var(--content-secondary);
  text-decoration: none; cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s;
}
.nav-item:hover:not(.disabled) {
  color: var(--content-primary);
  background: var(--sidebar-item-hover);
}
.nav-item.active {
  color: var(--sidebar-item-active-fg);
  background: var(--sidebar-item-active);
  border-color: var(--sidebar-item-active-border);
  box-shadow: var(--sidebar-item-active-shadow);
  font-weight: 600;
}
.nav-item.disabled { color: var(--content-muted); cursor: default; }
.nav-badge {
  margin-left: auto; font-size: 9px; font-weight: 600;
  color: var(--content-muted); background: var(--surface-glass);
  padding: 2px 6px; border-radius: var(--radius-pill); letter-spacing: 0.04em;
}

/* ── 底部 ── */
.sidebar-footer { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
/* 用户卡片 — 对齐前端 user-card 风格，暗色版 */
.user-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px; border-radius: var(--radius-md);
  background: var(--surface-glass);
  border: 1px solid var(--border-strong);
  box-shadow: inset 0 1px 0 var(--border-subtle);
  transition: background 0.15s;
}
.user-card:hover { background: var(--surface-glass-hover); }

.user-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: linear-gradient(135deg, var(--palette-purple-500), var(--palette-cyan-400));
  display: flex; align-items: center; justify-content: center;
  font-size: var(--font-size-md); font-weight: 700; color: var(--content-on-accent); flex-shrink: 0;
}
.user-info { flex: 1; min-width: 0; overflow: hidden; }
.user-name {
  font-size: var(--font-size-md); font-weight: 600; color: var(--content-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-bottom: 2px; margin-bottom: -2px;
}

.logout-btn {
  width: 24px; height: 24px; border-radius: 7px;
  background: none; border: none;
  color: var(--content-muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; transition: color 0.15s;
}
.logout-btn:hover { color: var(--content-primary); }

/* ── 主内容区 ── */
.admin-main {
  flex: 1;
  background: var(--surface-page);
  /* 不用 background-attachment: fixed——它把渐变钉在视口，滚动时每帧重绘整块导致闪动；
     本元素本身就是视口高的滚动容器，默认 scroll 已让背景相对自身固定，视觉一致且无重绘。 */
  overflow-y: auto;
  height: 100vh;
}
</style>
