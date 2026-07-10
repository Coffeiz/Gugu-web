import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import DefaultLayout from '@/layouts/DefaultLayout.vue'

const routes: RouteRecordRaw[] = [
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
    path: '/forgot-password',
    name: 'ForgotPassword',
    component: () => import('@/views/ForgotPassword.vue'),
    meta: { authPublic: true },
  },
  {
    // 重置链接从邮件点进来，登录与否都要可用 → 不加 authPublic（避免已登录被重定向走）
    path: '/reset-password',
    name: 'ResetPassword',
    component: () => import('@/views/ResetPassword.vue'),
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
      { path: '', redirect: '/projects' },
      // 总览面板暂时隐藏（个人用户用处不大，默认进项目）；代码保留，未来作团队功能再开启。
      // 取消注释即可恢复（同时恢复 AppSidebar 的「总览」导航项、Login/Register 的跳转目标）。
      // {
      //   path: 'dashboard',
      //   name: 'Dashboard',
      //   component: () => import('@/views/Dashboard/index.vue'),
      //   meta: { title: '总览' },
      // },
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
        // 思维面板：壳 + 子路由。记录（P1）已就绪；画布是 P2，届时加 canvases/:id
        // fullBleed：思维是「工作台」不是「管理」视图，隐藏 topbar 让便签流/画布铺满内容区
        // （记录页UI设计.md）；topbar 的全局搜索由页内胶囊条的便签筛选补位
        path: 'mind',
        component: () => import('@/views/Mind/index.vue'),
        meta: { title: '思维', fullBleed: true },
        children: [
          { path: '', redirect: '/mind/records' },
          {
            path: 'records',
            name: 'MindRecords',
            component: () => import('@/views/Mind/RecordsView.vue'),
            meta: { title: '思维', fullBleed: true },
          },
        ],
      },
      {
        path: 'schedules',
        name: 'Schedules',
        component: () => import('@/views/Schedules/index.vue'),
        meta: { title: '定时任务' },
      },
      // 新手引导 demo 面板：仅 dev 注册；prod build 时 import.meta.env.DEV=false，
      // 整个三元分支（含 import() 动态导入）被 tree-shake 掉，DevOnboarding.vue 不进生产包。
      ...(import.meta.env.DEV ? [{
        path: 'dev/onboarding',
        name: 'DevOnboarding',
        component: () => import('@/views/DevOnboarding.vue'),
        meta: { title: '新手引导 Demo' },
      }] : []),
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
    return { path: '/projects' }
  }
})

export default router
