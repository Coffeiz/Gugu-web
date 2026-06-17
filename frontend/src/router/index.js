import { createRouter, createWebHistory } from 'vue-router'
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import AdminLayout   from '@/layouts/AdminLayout.vue'

const routes = [
  // ── 用户认证页（无 layout）──
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { authPublic: true },
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/Register.vue'),
    meta: { authPublic: true },
  },

  // ── 主 App（需要用户登录）──
  {
    path: '/',
    component: DefaultLayout,
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: '/dashboard' },
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/Dashboard/index.vue'),
        meta: { title: '总览' },
      },
      {
        path: 'projects',
        name: 'Projects',
        component: () => import('@/views/Projects/index.vue'),
        meta: { title: '项目' },
      },
      {
        path: 'calendar',
        name: 'Calendar',
        component: () => import('@/views/Calendar/index.vue'),
        meta: { title: '日历' },
      },
      {
        path: 'files',
        name: 'Files',
        component: () => import('@/views/Files/index.vue'),
        meta: { title: '文件库' },
      },
    ],
  },

  // ── 管理后台（需要 admin token，与用户 token 分开）──
  {
    path: '/admin/login',
    name: 'AdminLogin',
    component: () => import('@/views/Admin/Login.vue'),
    meta: { adminPublic: true },
  },
  {
    path: '/admin',
    component: AdminLayout,
    meta: { requiresAdmin: true },
    children: [
      { path: '', redirect: '/admin/config' },
      {
        path: 'config',
        name: 'AdminConfig',
        component: () => import('@/views/Admin/Config/index.vue'),
        meta: { title: '系统配置', requiresAdmin: true },
      },
    ],
  },

  // 404
  { path: '/:pathMatch(.*)*', redirect: '/login' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const userToken  = localStorage.getItem('user_token')
  const adminToken = localStorage.getItem('admin_token')

  // 主 app 保护：未登录 → 跳到 /login
  if (to.meta.requiresAuth && !userToken) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  // 已登录用户访问登录/注册页 → 跳到 dashboard
  if (to.meta.authPublic && userToken) {
    return { path: '/dashboard' }
  }

  // Admin 区域保护
  if (to.meta.requiresAdmin && !adminToken) {
    return { path: '/admin/login', query: { redirect: to.fullPath } }
  }

  // 已登录 admin 再访问 admin/login → 跳到 config
  if (to.meta.adminPublic && adminToken) {
    return { path: '/admin/config' }
  }
})

export default router
