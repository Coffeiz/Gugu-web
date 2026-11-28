import { describe, expect, it } from 'vitest'
import { TtlCache } from '../../../src/agent/rag/ttl-cache.js'

describe('1.7.7 RAG TTL/LRU cache compatibility', () => {
  it('refreshes sliding TTL on hit and expires after a full silent window', () => {
    const minute = 60_000
    let now = 0
    const cache = new TtlCache<string>({ ttlMs: 30 * minute, now: () => now })
    cache.set('hot', 'v')
    now = 29 * minute
    expect(cache.get('hot')).toBe('v')
    now = 58 * minute
    expect(cache.get('hot')).toBe('v')
    now = 90 * minute
    expect(cache.get('hot')).toBeUndefined()
    cache.set('cold', 'v')
    now = 120 * minute + 1
    expect(cache.get('cold')).toBeUndefined()
  })

  it('keeps Infinity-TTL entries alive while LRU evicts the least recently used', () => {
    const cache = new TtlCache<string>({ ttlMs: Infinity, maxEntries: 2, now: () => 0 })
    cache.set('a', '1')
    cache.set('b', '2')
    expect(cache.get('a')).toBe('1')
    cache.set('c', '3')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('1')
    expect(cache.get('c')).toBe('3')
  })
})
