import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import { canAccessTerminals, workspacesApi } from '@/services/api'

const routes: RouteRecordRaw[] = [
  // ── 用户认证页（无 layout）──
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { authPublic: true },
  },
  {
    path: '/verify-email-change',
    name: 'VerifyEmailChange',
    component: () => import('@/views/VerifyEmailChange.vue'),
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
  {
    path: '/design',
    name: 'DesignTokens',
    component: () => import('@/views/Design/index.vue'),
    meta: { requiresAuth: true, title: 'Design Tokens' },
  },

  // ── 主 App（需要用户登录）──
  {
    path: '/',
    component: DefaultLayout,
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: () => {
        const view = localStorage.getItem('gugu-default-view')
        return view === 'calendar' ? '/calendar'
          : view === 'files' ? '/files'
          : view === 'mind' ? '/mind'
          : '/projects'
      } },
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
        meta: { title: 'navigation.projects' },
      },
      {
        path: 'calendar',
        name: 'Calendar',
        component: () => import('@/views/Calendar/index.vue'),
        meta: { title: 'navigation.calendar' },
      },
      {
        path: 'files',
        name: 'Files',
        component: () => import('@/views/Files/index.vue'),
        meta: { title: 'navigation.files' },
      },
      {
        path: 'skills',
        name: 'Skills',
        component: () => import('@/views/Skills/index.vue'),
        meta: { title: 'navigation.skills' },
      },
      {
        path: 'terminals',
        name: 'Terminals',
        component: () => import('@/views/Terminals/index.vue'),
        meta: { title: 'navigation.terminals' },
      },
      {
        // 思维面板：记录时间流与空间画布共享便签本体，但各自拥有独立界面。
        // fullBleed：思维是「工作台」不是「管理」视图，隐藏 topbar 让便签流/画布铺满内容区
        // （笔记页UI设计.md）；topbar 的全局搜索由页内胶囊条的便签筛选补位
        path: 'mind',
        component: () => import('@/views/Mind/index.vue'),
        meta: { title: 'navigation.mind', fullBleed: true },
        children: [
          {
            path: '',
            // 侧栏入口始终是 /mind：恢复用户上次停留的子视图；失效的画布 id 由 CanvasView 回退。
            redirect: () => {
              const lastMode = localStorage.getItem('mind-last-mode')
              return lastMode === 'canvas' ? '/mind/canvases' : '/mind/notes'
            },
          },
          {
            path: 'notes',
            name: 'MindNotes',
            component: () => import('@/views/Mind/NotesView.vue'),
            meta: { title: 'navigation.mind', fullBleed: true },
          },
          {
            path: 'canvases',
            name: 'MindCanvas',
            component: () => import('@/views/Mind/CanvasView.vue'),
            meta: { title: 'navigation.mind', fullBleed: true },
          },
        ],
      },
      {
        path: 'schedules',
        name: 'Schedules',
        component: () => import('@/views/Schedules/index.vue'),
        meta: { title: 'navigation.schedules' },
      },
      // /dev 索引页：列出下面所有 dev 工具的入口，新加工具只需要在 devRegistry.ts
      // 里加一条，不需要再想"入口放哪"。同样仅 dev 注册。
      ...(import.meta.env.DEV ? [{
        path: 'dev',
        name: 'DevHome',
        component: () => import('@/views/DevHome.vue'),
        meta: { title: 'navigation.devTools' },
      }] : []),
      // 新手引导 demo 面板：仅 dev 注册；prod build 时 import.meta.env.DEV=false，
      // 整个三元分支（含 import() 动态导入）被 tree-shake 掉，DevOnboarding.vue 不进生产包。
      ...(import.meta.env.DEV ? [{
        path: 'dev/onboarding',
        name: 'DevOnboarding',
        component: () => import('@/views/DevOnboarding.vue'),
        meta: { title: 'devOnboarding.title' },
      }] : []),
      ...(import.meta.env.DEV ? [{
        path: 'dev/email',
        name: 'DevEmail',
        component: () => import('@/views/DevEmail.vue'),
        meta: { title: 'devEmail.title' },
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

router.beforeEach(async (to) => {
  if (to.name !== 'Terminals') return
  try {
    const status = await workspacesApi.status()
    if (!canAccessTerminals(status)) return { path: '/projects' }
  } catch (cause) {
    const status = (cause as { status?: number }).status
    if (status === 401 || status === 403) return { path: '/projects' }
  }
})

export default router
