<template>
  <div class="admin-layout">
    <aside class="admin-sidebar">
      <!-- 品牌 -->
      <div class="sidebar-brand">
        <div class="brand-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 7h.01"/>
            <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>
            <path d="M20 7l2 .5-2 .5"/>
            <path d="M10 18v3"/>
            <path d="M14 17.75V21"/>
            <path d="M7 18a6 6 0 0 0 3.84-10.61"/>
          </svg>
        </div>
        <div class="brand-text">
          <div class="brand-name">咕咕</div>
          <div class="brand-tag">管理后台</div>
        </div>
      </div>

      <div class="sidebar-rule" />

      <!-- 导航 -->
      <nav class="sidebar-nav">
        <div class="nav-group-label">配置</div>
        <div class="nav-item" :class="{ active: isActive('/config') }" role="link" tabindex="0" @click="go('/config')">
          <PhGear :size="14" />
          系统配置
        </div>
        <div class="nav-item" :class="{ active: isActive('/agent') }" role="link" tabindex="0" @click="go('/agent')">
          <PhRobot :size="14" />
          Agent 配置
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">数据</div>
        <div class="nav-item" :class="{ active: isActive('/analytics') }" role="link" tabindex="0" @click="go('/analytics')">
          <PhChartLine :size="14" />
          数据总览
        </div>
        <div class="nav-item" :class="{ active: isActive('/analytics-usage') }" role="link" tabindex="0" @click="go('/analytics-usage')">
          <PhChartBar :size="14" />
          使用分析
        </div>
        <div class="nav-item" :class="{ active: isActive('/perception') }" role="link" tabindex="0" @click="go('/perception')">
          <PhBrain :size="14" />
          感知诊断
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">管理</div>
        <div class="nav-item" :class="{ active: isActive('/feedback') }" role="link" tabindex="0" @click="go('/feedback')">
          <PhFlag :size="14" />
          用户反馈
        </div>
        <div class="nav-item" :class="{ active: isActive('/invite-codes') }" role="link" tabindex="0" @click="go('/invite-codes')">
          <PhTicket :size="14" />
          邀请码
        </div>
        <div class="nav-item" :class="{ active: isActive('/users') }" role="link" tabindex="0" @click="go('/users')">
          <PhUsers :size="14" />
          用户管理
        </div>
        <div class="nav-item" :class="{ active: isActive('/quota') }" role="link" tabindex="0" @click="go('/quota')">
          <PhStack :size="14" />
          配额管理
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">运维</div>
        <div class="nav-item" :class="{ active: isActive('/services') }" role="link" tabindex="0" @click="go('/services')">
          <PhPulse :size="14" />
          服务状态
        </div>
        <div class="nav-item" :class="{ active: isActive('/ops') }" role="link" tabindex="0" @click="go('/ops')">
          <PhGauge :size="14" />
          运维监控
        </div>
        <div class="nav-item" :class="{ active: isActive('/storage-audit') }" role="link" tabindex="0" @click="go('/storage-audit')">
          <PhFolderSimpleDashed :size="14" />
          存储对账
        </div>
        <div class="nav-item" :class="{ active: isActive('/storage-monitor') }" role="link" tabindex="0" @click="go('/storage-monitor')">
          <PhChartLine :size="14" />
          存储监控
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">运营</div>
        <div class="nav-item" :class="{ active: isActive('/notifications') }" role="link" tabindex="0" @click="go('/notifications')">
          <PhBellRinging :size="14" />
          通知发布
        </div>

        <div class="sidebar-rule" style="margin:14px 4px" />
        <div class="nav-group-label">日志</div>
        <div class="nav-item" :class="{ active: isActive('/audit-log') }" role="link" tabindex="0" @click="go('/audit-log')">
          <PhClipboard :size="14" />
          操作日志
        </div>
        <div class="nav-item" :class="{ active: isActive('/system-logs') }" role="link" tabindex="0" @click="go('/system-logs')">
          <PhTerminal :size="14" />
          系统日志
        </div>
        <div class="nav-item" :class="{ active: isActive('/debug') }" role="link" tabindex="0" @click="go('/debug')">
          <PhBug :size="14" />
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
            <PhSignOut :size="14" />
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
import {
  PhGear, PhRobot, PhChartLine, PhChartBar, PhFlag, PhTicket, PhUsers,
  PhStack, PhPulse, PhClipboard, PhTerminal, PhBug, PhSignOut, PhBellRinging, PhBrain, PhGauge,
  PhFolderSimpleDashed,
} from '@phosphor-icons/vue'

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
  background: var(--surface-page);
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
  overflow: hidden;
  padding: 24px 14px;
  gap: 0;
}

/* 品牌 — 水平居中，对齐前端 logo 布局 */
.sidebar-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 0 8px;
  margin-bottom: 20px;
}
.brand-icon {
  width: 34px; height: 34px; border-radius: 10px;
  background: linear-gradient(135deg, var(--palette-purple-500), var(--palette-purple-400));
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.25);
}
.brand-text { line-height: 1; }
.brand-name { font-size: var(--font-size-lg); font-weight: 700; color: var(--content-primary); }
.brand-tag  { font-size: var(--font-size-xs); color: var(--content-muted); margin-top: 3px; }

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
  background: var(--surface-glass);
}
.nav-item.active {
  color: var(--content-primary);
  background: var(--surface-glass-hover);
  border-color: var(--border-strong);
  box-shadow: inset 0 1px 0 var(--border-subtle);
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
