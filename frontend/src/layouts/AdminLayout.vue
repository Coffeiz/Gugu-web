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
          数据分析
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
        <div class="nav-item" :class="{ active: isActive('/services') }" role="link" tabindex="0" @click="go('/services')">
          <PhPulse :size="14" />
          服务状态
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

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import {
  PhGear, PhRobot, PhChartLine, PhFlag, PhTicket, PhUsers,
  PhStack, PhPulse, PhClipboard, PhTerminal, PhBug, PhSignOut, PhBellRinging, PhBrain,
} from '@phosphor-icons/vue'

const route = useRoute()
const router = useRouter()
const adminStore = useAdminStore()
const initial = computed(() => (adminStore.adminUser?.username?.[0] ?? 'A').toUpperCase())

// 导航：编程式跳转，不渲染 <a href>，悬停时状态栏不暴露 URL
const isActive = (to) => route.path === to || route.path.startsWith(to + '/')
function go(to) {
  if (route.path !== to) router.push(to)
}
function goHash(to, hash) {
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
  background: linear-gradient(180deg, #0e101a 0%, #11131f 60%, #13152a 100%);
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(255,255,255,0.07);
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
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.25);
}
.brand-text { line-height: 1; }
.brand-name { font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.92); }
.brand-tag  { font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 3px; }

.sidebar-rule {
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.07) 30%, rgba(255,255,255,0.07) 70%, transparent 100%);
  margin: 0 4px;
}

/* ── 导航 ── */
.sidebar-nav {
  flex: 1; padding: 14px 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px;
  margin-right: -14px; padding-right: 14px;   /* 延伸到侧边栏右边缘，滚动条贴边 */
  scrollbar-gutter: stable;
}
.sidebar-nav::-webkit-scrollbar { width: 4px; }
.sidebar-nav::-webkit-scrollbar-track { background: transparent; }
.sidebar-nav::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 99px; }
.nav-group-label {
  font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
  color: rgba(255,255,255,0.2); text-transform: uppercase;
  padding: 0 10px; margin-bottom: 4px;
}
.nav-item {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border-radius: 10px;
  font-size: 14px; color: rgba(255,255,255,0.45);
  text-decoration: none; cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s;
}
.nav-item:hover:not(.disabled) {
  color: rgba(255,255,255,0.75);
  background: rgba(255,255,255,0.06);
}
.nav-item.active {
  color: rgba(255,255,255,0.92);
  background: rgba(255,255,255,0.1);
  border-color: rgba(255,255,255,0.12);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.07);
  font-weight: 600;
}
.nav-item.disabled { color: rgba(255,255,255,0.18); cursor: default; }
.nav-badge {
  margin-left: auto; font-size: 9px; font-weight: 600;
  color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.05);
  padding: 2px 6px; border-radius: 20px; letter-spacing: 0.04em;
}

/* ── 底部 ── */
.sidebar-footer { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
/* 用户卡片 — 对齐前端 user-card 风格，暗色版 */
.user-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px; border-radius: 14px;
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
  transition: background 0.15s;
}
.user-card:hover { background: rgba(255,255,255,0.1); }

.user-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #7ab8c8);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; color: white; flex-shrink: 0;
}
.user-info { flex: 1; min-width: 0; overflow: hidden; }
.user-name {
  font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.75);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-bottom: 2px; margin-bottom: -2px;
}

.logout-btn {
  width: 24px; height: 24px; border-radius: 7px;
  background: none; border: none;
  color: rgba(255,255,255,0.28); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; transition: color 0.15s;
}
.logout-btn:hover { color: rgba(255,255,255,0.7); }

/* ── 主内容区 ── */
.admin-main {
  flex: 1;
  background: linear-gradient(150deg, #0f1117 0%, #121626 40%, #161b30 70%, #1a1e38 100%);
  background-attachment: fixed;
  overflow-y: auto;
  height: 100vh;
}
</style>
