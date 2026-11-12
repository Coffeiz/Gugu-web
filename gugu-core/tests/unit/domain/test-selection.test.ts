import { expect, it } from 'vitest'
import { testSuites } from '../../../scripts/test-suites.mjs'

it('快速与集成集合覆盖全部已登记测试，边界标记自动归慢速且 IPC 不含 Python 对照', () => {
  const all = testSuites('all'),
    unit = testSuites('unit'),
    integration = testSuites('integration')
  expect(new Set([...unit, ...integration].map((item) => item.file))).toEqual(
    new Set(all.map((item) => item.file)),
  )
  expect(unit.some((item) => integration.some((other) => other.file === item.file))).toBe(
    false,
  )
  expect(unit.every((item) => item.markers.length === 0)).toBe(true)
  expect(integration.every((item) => item.markers.includes('slow'))).toBe(true)
  expect(
    testSuites('ipc').some(
      (item) => item.purpose === 'parity' || item.purpose === 'postgres',
    ),
  ).toBe(false)
  expect(() => testSuites('unknown')).toThrow('未知')
})
