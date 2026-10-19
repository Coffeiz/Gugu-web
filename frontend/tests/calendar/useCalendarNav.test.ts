import { computed, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { useCalendarNav } from '@/composables/calendar/useCalendarNav'

const VIEW_MODE_KEY = 'gugu-calendar-view-mode'

function createCalendarNav() {
  return useCalendarNav({
    cursor: ref(new Date(2026, 9, 1)),
    selectedDate: ref('2026-10-16'),
    todayIso: ref('2026-10-16'),
    weekRef: ref(new Date(2026, 9, 16)),
    weekDays: computed(() => [{ iso: '2026-10-12', md: '10/12' }, { iso: '2026-10-13', md: '10/13' }, { iso: '2026-10-14', md: '10/14' }, { iso: '2026-10-15', md: '10/15' }, { iso: '2026-10-16', md: '10/16' }, { iso: '2026-10-17', md: '10/17' }, { iso: '2026-10-18', md: '10/18' }]),
    locale: ref('zh-CN'),
  })
}

afterEach(() => localStorage.clear())

describe('useCalendarNav view preference', () => {
  it('restores the last selected calendar view and persists later changes', () => {
    expect(createCalendarNav().viewMode.value).toBe('month')

    const first = createCalendarNav()
    first.setView('week')
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('week')

    const restored = createCalendarNav()
    expect(restored.viewMode.value).toBe('week')
    restored.setView('month')
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('month')
    expect(createCalendarNav().viewMode.value).toBe('month')
  })

  it('ignores invalid stored values and keeps the default month view', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'day')
    expect(createCalendarNav().viewMode.value).toBe('month')
  })
})
