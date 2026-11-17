import { afterEach, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import DatabaseInitializationControl from '@/views/Admin/Config/components/DatabaseInitializationControl.vue'

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

it('部署管理 schema 时隐藏初始化操作并说明通过部署流程准备数据库', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(DatabaseInitializationControl, {
    supported: false,
    loading: false,
    label: '初始化数据库',
    loadingLabel: '初始化中',
    title: '重建数据库表',
    managedExternallyNote: '数据库结构由部署迁移流程管理',
  })
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)
  await nextTick()

  expect(host.querySelector('button')).toBeNull()
  expect(host.textContent).toContain('数据库结构由部署迁移流程管理')
})

it('传统后端仍显示初始化操作并向调用方发出执行事件', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  let initialized = false
  const app = createApp({
    render: () => h(DatabaseInitializationControl, {
      supported: true,
      loading: false,
      label: '初始化数据库',
      loadingLabel: '初始化中',
      title: '重建数据库表',
      managedExternallyNote: '数据库结构由部署迁移流程管理',
      onInitialize: () => { initialized = true },
    }),
  })
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)
  host.querySelector('button')?.click()
  await nextTick()

  expect(host.querySelector('button')?.textContent).toContain('初始化数据库')
  expect(initialized).toBe(true)
})
