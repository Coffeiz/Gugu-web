// @vitest-environment jsdom
import { createRenderer, defineComponent, h, nextTick, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { DoneGroup } from '@/views/Projects/components/done/doneTypes'
import DoneGroupComponent from '@/views/Projects/components/done/DoneGroup.vue'

vi.mock('@/components/common/icons/Icon.vue', () => ({
  default: defineComponent({ setup: () => () => h('span') }),
}))
vi.mock('@/components/common/controls/FlipChevron.vue', () => ({
  default: defineComponent({ setup: () => () => h('span') }),
}))
vi.mock('@/views/Projects/components/done/DoneCardList.vue', () => ({
  default: defineComponent({
    props: ['projects'],
    setup: props => () => h('div', { class: 'card-list' }, props.projects.map(project =>
      h('i', { class: 'project-card', key: project.id }),
    )),
  }),
}))

interface HostNode {
  type: string
  props: Record<string, unknown>
  children: HostNode[]
  parent: HostNode | null
  text?: string
}

const renderer = createRenderer<HostNode, HostNode>({
  createElement: type => ({ type, props: {}, children: [], parent: null }),
  createText: text => ({ type: '#text', props: {}, children: [], parent: null, text }),
  createComment: text => ({ type: '#comment', props: {}, children: [], parent: null, text }),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.children = []; node.text = text },
  patchProp: (node, key, _previous, value) => { node.props[key] = value },
  insert: (node, parent, anchor) => {
    if (node.parent) {
      const oldIndex = node.parent.children.indexOf(node)
      if (oldIndex >= 0) node.parent.children.splice(oldIndex, 1)
    }
    node.parent = parent
    const anchorIndex = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(anchorIndex < 0 ? parent.children.length : anchorIndex, 0, node)
  },
  remove: node => {
    if (!node.parent) return
    const index = node.parent.children.indexOf(node)
    if (index >= 0) node.parent.children.splice(index, 1)
    node.parent = null
  },
  parentNode: node => node.parent,
  nextSibling: node => {
    if (!node.parent) return null
    return node.parent.children[node.parent.children.indexOf(node) + 1] ?? null
  },
})

function countProjectCards(node: HostNode): number {
  return Number(node.props.class === 'project-card')
    + node.children.reduce((total, child) => total + countProjectCards(child), 0)
}

describe('DoneGroup 折叠年月组', () => {
  it('折叠时不挂载项目卡片，展开时再挂载组内卡片', async () => {
    const root: HostNode = { type: 'root', props: {}, children: [], parent: null }
    const group = reactive({
      key: 'month-2026-10月',
      type: 'month',
      label: '10月',
      year: '2026',
      month: '10月',
      open: false,
      items: [{ id: 7 }, { id: 8 }],
    }) as unknown as DoneGroup
    const app = renderer.createApp(DoneGroupComponent, {
      group,
      isProjectDetached: () => false,
    })
    app.mount(root)

    expect(countProjectCards(root)).toBe(0)
    group.open = true
    await nextTick()
    expect(countProjectCards(root)).toBe(2)

    app.unmount()
    vi.clearAllMocks()
  })
})
