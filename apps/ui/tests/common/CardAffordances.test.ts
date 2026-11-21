import { createApp, h, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import CardAffordances from '@/components/common/mind/CardAffordances.vue'

describe('CardAffordances', () => {
  it('无 hover 时隐藏附加按钮，hover 后显示并保留连接点状态', async () => {
    const hovering = ref(false)
    const host = document.createElement('div')
    document.body.appendChild(host)

    const app = createApp({
      setup: () => () => h(CardAffordances, {
        hovering: hovering.value,
        nodeId: 7,
        targetSide: 'right',
      }, {
        actions: () => h('button', { title: '移除' }, 'x'),
      }),
    })
    app.mount(host)

    const affordances = host.querySelector('[data-card-affordances]') as HTMLElement
    expect(affordances.dataset.affordancesState).toBe('connection-target')
    expect((host.querySelector('.card-affordances__actions') as HTMLElement).style.opacity).toBe('')
    expect(host.querySelector('.conn-dot-right')).not.toBeNull()

    hovering.value = true
    await nextTick()
    expect(affordances.dataset.affordancesState).toBe('connection-target')
    expect(affordances.classList.contains('hovering')).toBe(true)

    app.unmount()
    host.remove()
  })

  it('dragging、landing、revealing 状态隐藏附加交互，防止 landing 期间残留按钮或连接点命中', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(CardAffordances, { dragging: true, landing: true, revealing: true }, {
        actions: () => h('button', { title: '移除' }, 'x'),
      }),
    })
    app.mount(host)

    const affordances = host.querySelector('[data-card-affordances]') as HTMLElement
    expect(affordances.dataset.affordancesState).toBe('dragging')
    expect(affordances.classList.contains('is-dragging')).toBe(true)
    expect(affordances.classList.contains('is-landing')).toBe(true)
    expect(affordances.classList.contains('is-revealing')).toBe(true)

    app.unmount()
    host.remove()
  })
})
