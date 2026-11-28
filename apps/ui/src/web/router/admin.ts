import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AdminLayout from '@web/layouts/AdminLayout.vue'
import { useAdminStore } from '@/stores/admin'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'AdminLogin',
    component: () => import('@web/views/Admin/Login.vue'),
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
        component: () => import('@web/views/Admin/Config/index.vue'),
        meta: { title: 'admin.systemConfig' },
      },
      {
        path: 'analytics',
        name: 'AdminAnalytics',
        component: () => import('@web/views/Admin/Analytics/index.vue'),
        meta: { title: 'admin.analytics' },
      },
      {
        path: 'analytics-usage',
        name: 'AdminAnalyticsUsage',
        component: () => import('@web/views/Admin/Analytics/Usage.vue'),
        meta: { title: 'admin.usage' },
      },
      {
        path: 'perception',
        name: 'AdminPerception',
        component: () => import('@web/views/Admin/Perception/index.vue'),
        meta: { title: 'admin.perception' },
      },
      {
        path: 'agent',
        name: 'AdminAgent',
        component: () => import('@web/views/Admin/Agent/index.vue'),
        meta: { title: 'admin.agentConfig' },
      },
      { path: 'agent-behavior', name: 'AdminAgentBehavior', component: () => import('@web/views/Admin/AgentBehavior/index.vue'), meta: { title: 'admin.agentCapability' } },
      { path: 'agent-memory', name: 'AdminAgentMemory', component: () => import('@web/views/Admin/AgentMemory/index.vue'), meta: { title: 'admin.agentMemory' } },
      { path: 'agent-usage', name: 'AdminAgentUsage', component: () => import('@web/views/Admin/AgentUsage/index.vue'), meta: { title: 'admin.agentUsage' } },
      {
        path: 'users',
        name: 'AdminUsers',
        component: () => import('@web/views/Admin/Users/index.vue'),
        meta: { title: 'admin.userManagement' },
      },
      {
        path: 'quota',
        name: 'AdminQuota',
        component: () => import('@web/views/Admin/Quota/index.vue'),
        meta: { title: 'admin.quota' },
      },
      {
        path: 'sandbox',
        name: 'AdminSandbox',
        component: () => import('@web/views/Admin/Sandbox/index.vue'),
        meta: { title: 'admin.sandbox' },
      },
      {
        path: 'feedback',
        name: 'AdminFeedback',
        component: () => import('@web/views/Admin/Feedback/index.vue'),
        meta: { title: 'admin.feedback' },
      },
      {
        path: 'audit-log',
        name: 'AdminAuditLog',
        component: () => import('@web/views/Admin/AuditLog/index.vue'),
        meta: { title: 'admin.auditLog' },
      },
      {
        path: 'system-logs',
        name: 'AdminSystemLogs',
        component: () => import('@web/views/Admin/SystemLogs/index.vue'),
        meta: { title: 'admin.systemLogs' },
      },
      {
        path: 'services',
        name: 'AdminServices',
        component: () => import('@web/views/Admin/Services/index.vue'),
        meta: { title: 'admin.services' },
      },
      {
        path: 'updates',
        name: 'AdminUpdates',
        component: () => import('@web/views/Admin/Updates/index.vue'),
        meta: { title: 'admin.updates' },
      },
      {
        path: 'storage-monitor',
        name: 'AdminStorageMonitor',
        component: () => import('@web/views/Admin/Ops/Storage.vue'),
        meta: { title: 'admin.storageMonitor' },
      },
      {
        path: 'ops',
        name: 'AdminOps',
        component: () => import('@web/views/Admin/Ops/index.vue'),
        meta: { title: 'admin.ops' },
      },
      {
        path: 'debug',
        name: 'AdminDebug',
        component: () => import('@web/views/Admin/Debug/index.vue'),
        meta: { title: 'admin.debugLogs' },
      },
      {
        path: 'notifications',
        name: 'AdminNotifications',
        component: () => import('@web/views/Admin/Notifications/index.vue'),
        meta: { title: 'admin.publishNotifications' },
      },
      {
        path: 'email',
        name: 'AdminEmail',
        component: () => import('@web/views/Admin/Email/index.vue'),
        meta: { title: 'adminEmailUi.title' },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/login' },
]

const router = createRouter({
  history: createWebHistory('/admin'),
  routes,
})

router.beforeEach(async (to) => {
  if (to.meta.requiresAdmin || to.meta.adminPublic) {
    const adminStore = useAdminStore()
    const valid = adminStore.adminUser ? true : await adminStore.validateSession()
    if (to.meta.adminPublic && valid === true) return { path: '/config' }
    if (to.meta.requiresAdmin && valid === false) {
      return { path: '/login', query: { redirect: to.fullPath } }
    }
    if (to.meta.requiresAdmin && valid === null) return false
  }
})

export default router
