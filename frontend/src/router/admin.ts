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
        meta: { title: '系统配置' },
      },
      {
        path: 'analytics',
        name: 'AdminAnalytics',
        component: () => import('@/views/Admin/Analytics/index.vue'),
        meta: { title: '数据分析' },
      },
      {
        path: 'perception',
        name: 'AdminPerception',
        component: () => import('@/views/Admin/Perception/index.vue'),
        meta: { title: '感知诊断' },
      },
      {
        path: 'agent',
        name: 'AdminAgent',
        component: () => import('@/views/Admin/Agent/index.vue'),
        meta: { title: 'Agent 配置' },
      },
      {
        path: 'users',
        name: 'AdminUsers',
        component: () => import('@/views/Admin/Users/index.vue'),
        meta: { title: '用户管理' },
      },
      {
        path: 'quota',
        name: 'AdminQuota',
        component: () => import('@/views/Admin/Quota/index.vue'),
        meta: { title: '配额管理' },
      },
      {
        path: 'invite-codes',
        name: 'AdminInviteCodes',
        component: () => import('@/views/Admin/InviteCodes/index.vue'),
        meta: { title: '邀请码管理' },
      },
      {
        path: 'feedback',
        name: 'AdminFeedback',
        component: () => import('@/views/Admin/Feedback/index.vue'),
        meta: { title: '用户反馈' },
      },
      {
        path: 'audit-log',
        name: 'AdminAuditLog',
        component: () => import('@/views/Admin/AuditLog/index.vue'),
        meta: { title: '操作日志' },
      },
      {
        path: 'system-logs',
        name: 'AdminSystemLogs',
        component: () => import('@/views/Admin/SystemLogs/index.vue'),
        meta: { title: '系统日志' },
      },
      {
        path: 'services',
        name: 'AdminServices',
        component: () => import('@/views/Admin/Services/index.vue'),
        meta: { title: '服务状态' },
      },
      {
        path: 'debug',
        name: 'AdminDebug',
        component: () => import('@/views/Admin/Debug/index.vue'),
        meta: { title: 'Debug 日志' },
      },
      {
        path: 'notifications',
        name: 'AdminNotifications',
        component: () => import('@/views/Admin/Notifications/index.vue'),
        meta: { title: '通知发布' },
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
