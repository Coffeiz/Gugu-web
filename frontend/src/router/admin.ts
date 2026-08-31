import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AdminLayout from '@/layouts/AdminLayout.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'AdminLogin',
    component: () => import('@/views/Admin/Login.vue'),
    meta: { adminPublic: true },
  },
  {
    path: '/',
    component: AdminLayout,
    meta: { requiresAdmin: true },
    children: [
      { path: '', redirect: '/config' },
      {
        path: 'config',
        name: 'AdminConfig',
        component: () => import('@/views/Admin/Config/index.vue'),
        meta: { title: 'admin.systemConfig' },
      },
      {
        path: 'analytics',
        name: 'AdminAnalytics',
        component: () => import('@/views/Admin/Analytics/index.vue'),
        meta: { title: 'admin.analytics' },
      },
      {
        path: 'analytics-usage',
        name: 'AdminAnalyticsUsage',
        component: () => import('@/views/Admin/Analytics/Usage.vue'),
        meta: { title: 'admin.usage' },
      },
      {
        path: 'perception',
        name: 'AdminPerception',
        component: () => import('@/views/Admin/Perception/index.vue'),
        meta: { title: 'admin.perception' },
      },
      {
        path: 'agent',
        name: 'AdminAgent',
        component: () => import('@/views/Admin/Agent/index.vue'),
        meta: { title: 'admin.agentConfig' },
      },
      { path: 'agent-behavior', name: 'AdminAgentBehavior', component: () => import('@/views/Admin/AgentBehavior/index.vue'), meta: { title: 'admin.agentCapability' } },
      { path: 'agent-memory', name: 'AdminAgentMemory', component: () => import('@/views/Admin/AgentMemory/index.vue'), meta: { title: 'admin.agentMemory' } },
      { path: 'agent-usage', name: 'AdminAgentUsage', component: () => import('@/views/Admin/AgentUsage/index.vue'), meta: { title: 'admin.agentUsage' } },
      {
        path: 'users',
        name: 'AdminUsers',
        component: () => import('@/views/Admin/Users/index.vue'),
        meta: { title: 'admin.userManagement' },
      },
      {
        path: 'quota',
        name: 'AdminQuota',
        component: () => import('@/views/Admin/Quota/index.vue'),
        meta: { title: 'admin.quota' },
      },
      {
        path: 'sandbox',
        name: 'AdminSandbox',
        component: () => import('@/views/Admin/Sandbox/index.vue'),
        meta: { title: 'admin.sandbox' },
      },
      {
        path: 'feedback',
        name: 'AdminFeedback',
        component: () => import('@/views/Admin/Feedback/index.vue'),
        meta: { title: 'admin.feedback' },
      },
      {
        path: 'audit-log',
        name: 'AdminAuditLog',
        component: () => import('@/views/Admin/AuditLog/index.vue'),
        meta: { title: 'admin.auditLog' },
      },
      {
        path: 'system-logs',
        name: 'AdminSystemLogs',
        component: () => import('@/views/Admin/SystemLogs/index.vue'),
        meta: { title: 'admin.systemLogs' },
      },
      {
        path: 'services',
        name: 'AdminServices',
        component: () => import('@/views/Admin/Services/index.vue'),
        meta: { title: 'admin.services' },
      },
      {
        path: 'storage-audit',
        name: 'AdminStorageAudit',
        component: () => import('@/views/Admin/StorageAudit/index.vue'),
        meta: { title: 'admin.storageAudit' },
      },
      {
        path: 'storage-monitor',
        name: 'AdminStorageMonitor',
        component: () => import('@/views/Admin/Ops/Storage.vue'),
        meta: { title: 'admin.storageMonitor' },
      },
      {
        path: 'ops',
        name: 'AdminOps',
        component: () => import('@/views/Admin/Ops/index.vue'),
        meta: { title: 'admin.ops' },
      },
      {
        path: 'debug',
        name: 'AdminDebug',
        component: () => import('@/views/Admin/Debug/index.vue'),
        meta: { title: 'admin.debugLogs' },
      },
      {
        path: 'notifications',
        name: 'AdminNotifications',
        component: () => import('@/views/Admin/Notifications/index.vue'),
        meta: { title: 'admin.publishNotifications' },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/login' },
]

const router = createRouter({
  history: createWebHistory('/admin'),
  routes,
})

router.beforeEach((to) => {
  const adminToken = localStorage.getItem('admin_token')

  if (to.meta.requiresAdmin && !adminToken) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.meta.adminPublic && adminToken) {
    return { path: '/config' }
  }
})

export default router
