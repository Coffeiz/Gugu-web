import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

export const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const boundaries = ['slow', 'external_service', 'process', 'e2e_support']

export function testSuites(suite) {
  const manifest = JSON.parse(readFileSync(join(coreRoot, 'tests/suites.json'), 'utf8'))
  const discovered = []
  function visit(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) visit(path)
      else if (item.name.endsWith('.test.ts'))
        discovered.push(relative(coreRoot, path).replaceAll('\\', '/'))
    }
  }
  visit(join(coreRoot, 'tests'))
  if (
    discovered.some((file) => !Object.hasOwn(manifest, file)) ||
    Object.keys(manifest).some((file) => !discovered.includes(file))
  )
    throw new Error('Core 测试发现与分类清单不一致，请登记或清理 tests/suites.json')
  const selectors = {
    unit: (item) => !item.markers.some((marker) => boundaries.includes(marker)),
    integration: (item) => item.markers.some((marker) => boundaries.includes(marker)),
    ipc: (item) => item.purpose === 'ipc',
    postgres: (item) => item.purpose === 'postgres',
    parity: (item) => item.purpose === 'parity',
    all: () => true,
    default: (item) => item.purpose !== 'postgres' && item.purpose !== 'parity',
  }
  if (!Object.hasOwn(selectors, suite)) throw new Error('未知 Core 测试层级')
  const selected = Object.entries(manifest)
    .map(([file, item]) => {
      if (
        !Array.isArray(item.markers) ||
        item.markers.some((marker) => !boundaries.includes(marker)) ||
        !['L0', 'L1', 'L2'].includes(item.layer) ||
        !['contract', 'ipc', 'postgres', 'parity'].includes(item.purpose)
      )
        throw new Error(`Core 测试标记无效：${file}`)
      const markers = [...new Set(item.markers)]
      if (markers.includes('process') || markers.includes('external_service'))
        markers.push('slow')
      return { file, ...item, markers: [...new Set(markers)] }
    })
    .filter(selectors[suite])
  if (!selected.length) throw new Error('Core 测试选择为空，拒绝假绿')
  return selected
}
