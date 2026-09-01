#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
  encoding: 'utf8',
}).split('\n').filter(file => file && fs.existsSync(path.join(root, file)))

const testLike = files.filter(file =>
  /(^|\/)test_[^/]+\.py$|\.(test|spec)\.(ts|js)$|\/check-[^/]+\.mjs$/.test(file),
)

const known = file => (
  /^backend\/tests\/test_[^/]+\.py$/.test(file)
  || /^backend\/test_[^/]+\.py$/.test(file)
  || /^backend\/scripts\/diagnostics\/test_[^/]+\.py$/.test(file)
  || /^backend\/ts\/.+\.test\.ts$/.test(file)
  || /^loopscope\/.+\.test\.ts$/.test(file)
  || /^frontend\/(src|test)\/.+\.test\.ts$/.test(file)
  || /^frontend\/e2e\/[^/]+\.spec\.ts$/.test(file)
  || /^frontend\/scripts\/check-[^/]+\.mjs$/.test(file)
  || /^scripts\/licenses\/check-[^/]+\.mjs$/.test(file)
  || /^scripts\/tests\/.+\.mjs$/.test(file)
)

const unknown = testLike.filter(file => !known(file))
const skipFiles = testLike.filter(file => {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '')
  return /(?:test|it|describe)\.skip\s*\(|pytest\.(?:skip|mark\.skip)|@pytest\.mark\.skip/.test(source)
})

if (unknown.length) {
  console.error('[测试边界] 发现未纳入白名单的测试文件：')
  for (const file of unknown) console.error(`- ${file}`)
  process.exitCode = 1
}

console.log(`[测试边界] 已检查 ${testLike.length} 个测试相关文件；未知目录 ${unknown.length} 个；含 skip ${skipFiles.length} 个。`)
if (skipFiles.length) {
  console.warn('[测试边界] 含 skip 的文件（需在测试清单中人工确认）：')
  for (const file of skipFiles) console.warn(`- ${file}`)
}
