import { describe, expect, it } from 'vitest'
import type { components } from '@/types/api'
import { canDrag, canResize, getDisplayColor, typeLabel } from './calendarRules'
import { normalizeEvent, normalizeProjectTimeline, toRenderItem } from './calendarNormalizer'

type EventResponse = components['schemas']['EventResponse']

describe('calendar domain', () => {
  it('分别归一化活动和项目时间线，并保留渲染适配所需字段', () => {
    const event = normalizeEvent({
      id: 7,
      title: '评审',
      date: '2026-08-09',
      time: '10:00',
      endTime: '11:00',
      type: 'review',
      client: null,
      description: '说明',
      version: 2,
    } as EventResponse)
    const project = normalizeProjectTimeline({
      id: 'p7',
      name: '项目',
      startDate: '2026-08-09',
      endDate: '2026-08-12',
      accent: '#123456',
      status: 'active',
    })

    expect(event.type).toBe('event')
    expect(event.allDay).toBe(false)
    expect(project.type).toBe('project')
    expect(project.allDay).toBe(true)
    expect(toRenderItem(event).name).toBe('评审')
    expect(toRenderItem(project, { legacyType: 'deadline' }).calendarType).toBe('project')
  })

  it('规则只从领域类型和配置派生，不依赖派生布尔字段', () => {
    const event = normalizeEvent({ id: 1, title: '活动', date: '2026-08-09', type: 'event' } as EventResponse)
    const project = normalizeProjectTimeline({ id: 2, name: '项目', startDate: '2026-08-09', endDate: '2026-08-10', accent: '#123456', status: 'active' })
    const doneProject = normalizeProjectTimeline({ id: 3, name: '已完成项目', startDate: '2026-08-09', endDate: '2026-08-10', accent: '#123456', status: 'done' })

    expect(canDrag(event)).toBe(true)
    expect(canResize(project)).toBe(true)
    expect(canDrag(doneProject)).toBe(false)
    expect(canResize(doneProject)).toBe(false)
    expect(getDisplayColor(project)).toBe('#123456')
    expect(typeLabel('review')).toBe('审核')
    expect(typeLabel('unknown')).toBe('活动')
  })
})
