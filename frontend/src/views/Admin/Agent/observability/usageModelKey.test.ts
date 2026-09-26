import { describe, expect, it } from 'vitest'
import { usageModelKey } from './usageModelKey'

describe('usageModelKey', () => {
  it('keeps same-named models from different providers as distinct rows', () => {
    const rows = [
      { model: 'mimo-v2.5', provider: 'mimo' },
      { model: 'mimo-v2.5', provider: 'compatibility' },
    ]

    expect(new Set(rows.map(usageModelKey)).size).toBe(rows.length)
  })

  it('keeps the identity stable for the same provider and model pair', () => {
    expect(usageModelKey({ model: 'mimo-v2.5', provider: 'mimo' }))
      .toBe(usageModelKey({ model: 'mimo-v2.5', provider: 'mimo' }))
  })
})
