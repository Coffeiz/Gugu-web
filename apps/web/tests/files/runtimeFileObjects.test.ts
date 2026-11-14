// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, ref, type Component } from 'vue'

const mocks = vi.hoisted(() => ({
  sequence: 0,
  objects: new Map<string, Record<string, any>>(),
  surfaces: new Map<string, Record<string, any>>(),
  bind: vi.fn(), dispose: vi.fn(), update: vi.fn(), unregister: vi.fn(), unregisterSurface: vi.fn(),
}))
vi.mock('@/interaction/runtime', () => ({
  runtime: {
    objects: {
      register: (item: Record<string, any>) => {
        const generation = ++mocks.sequence
        mocks.objects.set(item.id, { ...item, generation })
        return generation
      },
      get: (id: string) => mocks.objects.get(id),
      update: (id: string, values: Record<string, any>) => {
        mocks.update(id, values)
        Object.assign(mocks.objects.get(id)!, values)
      },
      setElement: (id: string, element: HTMLElement | null) => { mocks.objects.get(id)!.element = element },
    },
    surfaces: {
      register: (item: Record<string, any>) => {
        const generation = ++mocks.sequence
        mocks.surfaces.set(item.id, { ...item, generation })
        return generation
      },
      get: (id: string) => mocks.surfaces.get(id),
      unregister: mocks.unregisterSurface,
    },
    unregisterObjectWhenIdle: mocks.unregister,
  },
  bindRuntimeObjectPointer: (id: string, element: HTMLElement) => {
    mocks.bind(id, element)
    return () => mocks.dispose(id, element)
  },
}))

import { i18n } from '@/i18n'
import RuntimeFileCard from '@/components/common/file-browser/RuntimeFileCard.vue'
import RuntimeFolderCard from '@/components/common/file-browser/RuntimeFolderCard.vue'
import RuntimeListRow from '@/components/common/file-browser/RuntimeListRow.vue'
import RuntimeFileListRow from '@/views/Files/components/RuntimeFileListRow.vue'
import RuntimeFolderListRow from '@/views/Files/components/RuntimeFolderListRow.vue'
import { useFileRuntimeObject } from '@/composables/files/useFileRuntimeObject'

const variants: Array<{ name: string; component: Component; type: string; surface: boolean }> = [
  { name: '文件卡片', component: RuntimeFileCard, type: 'file-item', surface: false },
  { name: '文件夹卡片', component: RuntimeFolderCard, type: 'folder-item', surface: true },
  { name: '通用列表行', component: RuntimeListRow, type: 'folder-item', surface: true },
  { name: '文件库文件行', component: RuntimeFileListRow, type: 'file-item', surface: false },
  { name: '文件库文件夹行', component: RuntimeFolderListRow, type: 'folder-item', surface: true },
]
let app: ReturnType<typeof createApp> | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  mocks.objects.clear()
  mocks.surfaces.clear()
  vi.clearAllMocks()
})
afterEach(() => { app?.unmount(); app = undefined; host?.remove(); host = undefined })

async function mountVariant(variant: typeof variants[number]) {
  const state = reactive({ runtimeId: 'sample:7', runtimeType: variant.type, runtimeSurfaceId: 'library', runtimeSelected: false, runtimeAbilities: ['move'] })
  const context = {
    selectedIds: ref(new Set()), previewFileIds: ref(new Set()), selectedFolderKeys: ref(new Set()), previewFolderKeys: ref(new Set()),
    inSelectionMode: ref(true), renamingFileId: ref(null), renamingFolderKey: ref(null), renameText: ref(''), renameExtension: ref('MD'),
    cbStore: { isCut: () => false }, fileListIcon: () => 'span', folderListIcon: () => 'span', fileIconColor: () => '#888888', folderAccentColor: () => '#888888',
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(variant.component, {
    ...state, context, cardProps: { displayName: '示例', ext: 'MD' },
    item: { id: 7, folderId: 7, type: 'folder', displayName: '示例', ext: 'MD', sizeBytes: 7 },
  }) })
  app.use(i18n)
  app.mount(host)
  await nextTick()
  await nextTick()
  return state
}

describe('文件 Runtime 包装器保持对象生命周期', () => {
  it('临时 DOM 已交接给 Runtime 时，旧视图的空 ref 不得清掉新 DOM', async () => {
    let binding!: ReturnType<typeof useFileRuntimeObject>
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({ setup() {
      binding = useFileRuntimeObject(() => 'handoff:7', () => ({ type: 'file-item', surfaceId: 'library', abilities: ['move'], selected: false }))
      return () => h('div', { ref: binding.elementRef })
    } })
    app.mount(host)
    await nextTick()
    const record = mocks.objects.get('handoff:7')!
    const clone = document.createElement('div')
    record.element = clone
    binding.elementRef.value = null
    await nextTick()
    expect(record.element).toBe(clone)
    expect(mocks.dispose).not.toHaveBeenCalled()
  })

  it.each(variants)('$name 挂载绑定 DOM、同步属性并在卸载时释放当前实例', async variant => {
    const state = await mountVariant(variant)
    const record = mocks.objects.get(state.runtimeId)!
    const generation = record.generation
    expect(record.type).toBe(variant.type)
    expect(record.element).toBeInstanceOf(HTMLElement)
    expect(mocks.bind).toHaveBeenCalledWith(state.runtimeId, record.element)
    state.runtimeSelected = true
    state.runtimeSurfaceId = 'next-library'
    state.runtimeAbilities.push('copy')
    await nextTick()
    expect(record).toMatchObject({ selected: true, surfaceId: 'next-library', abilities: ['move', 'copy'] })
    app!.unmount()
    app = undefined
    expect(mocks.dispose).toHaveBeenCalledWith(state.runtimeId, record.element)
    expect(mocks.unregister).toHaveBeenCalledWith(state.runtimeId, generation)
    expect(mocks.unregisterSurface).toHaveBeenCalledTimes(variant.surface ? 1 : 0)
  })

  it.each(variants)('$name 的旧实例不得更新或注销同 ID 的新 generation', async variant => {
    const state = await mountVariant(variant)
    const previous = mocks.objects.get(state.runtimeId)!
    const next = { ...previous, generation: previous.generation + 100, selected: false }
    mocks.objects.set(state.runtimeId, next)
    const surfaceId = `${state.runtimeId}:surface`
    if (variant.surface) mocks.surfaces.set(surfaceId, { generation: 9999 })
    mocks.update.mockClear()
    state.runtimeSelected = true
    await nextTick()
    expect(mocks.update).not.toHaveBeenCalled()
    app!.unmount()
    app = undefined
    expect(mocks.unregister).not.toHaveBeenCalled()
    expect(mocks.unregisterSurface).not.toHaveBeenCalled()
    expect(mocks.objects.get(state.runtimeId)).toBe(next)
  })
})
