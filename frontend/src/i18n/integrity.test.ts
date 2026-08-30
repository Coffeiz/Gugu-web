import { describe, expect, it } from 'vitest'
import { localeRegistry } from './registry'

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

describe('locale message registry', () => {
  it('keeps every locale on the same key set', () => {
    const baseline = leafPaths(localeRegistry['zh-CN']).sort()
    expect(leafPaths(localeRegistry['ja-JP']).sort()).toEqual(baseline)
    expect(leafPaths(localeRegistry['en-US']).sort()).toEqual(baseline)
  })
})
