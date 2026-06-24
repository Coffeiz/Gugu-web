import { createRouter, createWebHistory } from 'vue-router'
import DefaultLayout from '@/layouts/DefaultLayout.vue'

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
  {
    path: '/privacy',
    name: 'Privacy',
    component: () => import('@/views/Privacy.vue'),
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
      {
        path: 'schedules',
        name: 'Schedules',
        component: () => import('@/views/Schedules/index.vue'),
        meta: { title: '定时任务' },
      },
    ],
  },

  // 404（登录与否都直接展示，不跳登录）
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/NotFound.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const userToken = localStorage.getItem('user_token')

  if (to.meta.requiresAuth && !userToken) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  if (to.meta.authPublic && userToken) {
    return { path: '/dashboard' }
  }
})

export default router
