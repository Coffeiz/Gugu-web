import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const metadataDir = path.join(root, 'docs/testing/metadata')
export function groupFor(file) {
  const parts = file.split('/')
  if (file.startsWith('packages/core/tests/')) return parts[3] || 'core'
  if (file.startsWith('apps/web-host/tests/')) return parts[3] || 'web-host'
  if (file.startsWith('backend/tests/')) return parts[2] || 'backend'
  if (file.startsWith('apps/web/tests/')) return parts[3] || 'web'
  return 'other'
}
export function loadMetadata() {
  const result = {}
  for (const name of fs.readdirSync(metadataDir).filter(name => name.endsWith('.json')).sort()) {
    const items = JSON.parse(fs.readFileSync(path.join(metadataDir, name), 'utf8'))
    for (const [file, item] of Object.entries(items)) {
      if (Object.hasOwn(result, file)) throw new Error(`重复测试元数据：${file}`)
      result[file] = item
    }
  }
  return result
}
