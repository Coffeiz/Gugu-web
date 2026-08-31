#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../..')
const workflowPath = path.join(root, '.github/workflows/runtime-integration.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')
const outputPath = process.argv.slice(2).find(arg => arg.startsWith('--output='))?.slice('--output='.length)

function gitFiles(glob) {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', glob], {
    cwd: root,
    encoding: 'utf8',
  }).split('\n').filter(file => file && fs.existsSync(path.join(root, file)))
}

function lastChanged(file) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%ad', '--date=short', '--', file], {
      cwd: root,
      encoding: 'utf8',
    }).trim() || null
  } catch {
    return null
  }
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

function countMatches(source, pattern) {
  return (source.match(pattern) ?? []).length
}

function executableSource(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '')
}

function domainFor(file) {
  const value = file.toLowerCase()
  const domains = [
    ['security', /security|ownership|confirm|redaction|url_security|auth_cookie|account|admin_|config_|onboarding|error_redaction/],
    ['context', /context|compaction|canonical|session|cache_prefix|modelctx|cache_|cross_call_cache|assembly|prefix_optimization|locale_continuous|history_/],
    ['im', /(^|[/_])im|qq_|wechat|feishu|interaction|message_format|notifications|qface|feedback_email/],
    ['storage', /storage|file|folder|upload|trash|video|attachment|path_|key_strategy|web_download|p2b_|io_retry_contract/],
    ['agent-provider', /agent|provider|llm|tool_|schema|runner|stream|capability|behaviors|commands|byok|loop_driver|core_|local_deployment|minimax|valueerror|user_skills|preferences_/],
    ['memory-rag', /memory|rag|knowledge|stance|search|searxng|compare_index|scoped_store/],
    ['mind-project', /mind|canvas|project/],
    ['schedule', /schedule|worker_shutdown|datetime|tz_|regressions/],
    ['terminal-runtime', /terminal|shell|docker|runtime|loopscope|process|systemd|trace_ops|run_finalize/],
    ['frontend-ui', /frontend\/|calendar|markdown|iconregistry|affordances|byokcredentials|accountboundary|cardoptimistic|datescrubber|flipcoordinator|optimisticmutation|check-/],
    ['frontend-i18n-theme', /i18n|theme|style|token|formatters/],
  ]
  return domains.find(([, matcher]) => matcher.test(value))?.[0] ?? 'other'
}

function layerFor(file, kind) {
  const value = file.toLowerCase()
  if (value.includes('/e2e/')) return 'L3'
  if (value.includes('/diagnostics/')) return 'L2'
  if (value.includes('docker') || value.includes('pty') || value.includes('raw_ws') || value.includes('terminal_streaming')) return 'L2'
  if (value.includes('/scripts/') && !value.includes('/tests/')) return 'L0'
  if (kind === 'vitest' || kind === 'static-check') return 'L0'
  return 'L1'
}

function ownerFor(file, kind, domain) {
  if (kind === 'playwright') return 'frontend/e2e'
  if (kind === 'static-check') return '工程质量'
  if (kind === 'diagnostic-script') return 'backend/diagnostics'
  if (kind === 'node-test') return file.startsWith('loopscope/') ? 'loopscope/runtime' : 'backend/ts'
  if (kind === 'vitest') return `frontend/${domain}`
  return `backend/${domain}`
}

function inventoryItem(file, kind) {
  const source = read(file)
  const runnableSource = executableSource(source)
  const isE2e = kind === 'playwright'
  const declaredTestCount = isE2e
    ? countMatches(source, /\b(test|test\.describe)\s*\(/g)
    : kind === 'pytest'
      ? countMatches(source, /^\s*(?:async\s+)?def\s+test_[A-Za-z0-9_]+\s*\(/gm)
      : countMatches(source, /\b(?:it|test)(?:\.each|\.skip|\.only)?\s*\(/g)
  const ci = isE2e
    ? workflow.includes(path.basename(file))
    : kind === 'vitest'
      ? workflow.includes('npm run test:run') || workflow.includes('pnpm test')
      : kind === 'node-test'
        ? false
        : kind === 'diagnostic-script'
          ? false
          : kind === 'pytest'
            ? workflow.includes('pytest -q')
            : false
  const domain = domainFor(file)
  return {
    file,
    kind,
    layer: layerFor(file, kind),
    domain,
    owner: ownerFor(file, kind, domain),
    ownerReview: domain === 'other' ? '待复核' : '自动归类',
    declaredTestCount,
    ci,
    hasSkip: /(?:test|it|describe)\.skip\s*\(|pytest\.(?:skip|mark\.skip)|@pytest\.mark\.skip/.test(runnableSource),
    externalDependency: /docker|redis|postgres|websocket|pty|playwright|real[_ -]?llm|third[- ]?party/i.test(source),
    lastChanged: lastChanged(file),
  }
}

const items = [
  ...gitFiles('backend/tests/test_*.py').map(file => inventoryItem(file, 'pytest')),
  ...gitFiles('backend/scripts/diagnostics').filter(file => /\/test_[^/]+\.py$/.test(file)).map(file => inventoryItem(file, 'diagnostic-script')),
  ...gitFiles('backend/ts').filter(file => file.endsWith('.test.ts')).map(file => inventoryItem(file, 'node-test')),
  ...gitFiles('loopscope').filter(file => file.endsWith('.test.ts')).map(file => inventoryItem(file, 'node-test')),
  ...gitFiles('frontend/src').filter(file => file.endsWith('.test.ts')).map(file => inventoryItem(file, 'vitest')),
  ...gitFiles('frontend/test').filter(file => file.endsWith('.test.ts')).map(file => inventoryItem(file, 'vitest')),
  ...gitFiles('frontend/e2e/*.spec.ts').map(file => inventoryItem(file, 'playwright')),
  ...gitFiles('frontend/scripts').filter(file => /\/check-[^/]+\.mjs$/.test(file)).map(file => inventoryItem(file, 'static-check')),
  ...gitFiles('scripts/licenses').filter(file => /\/check-[^/]+\.mjs$/.test(file)).map(file => inventoryItem(file, 'static-check')),
].sort((left, right) => left.file.localeCompare(right.file))

const summary = items.reduce((result, item) => {
  result.files += 1
  result.declaredTests += item.declaredTestCount
  result.byKind[item.kind] = (result.byKind[item.kind] ?? 0) + 1
  result.byLayer[item.layer] = (result.byLayer[item.layer] ?? 0) + 1
  result.byDomain[item.domain] = (result.byDomain[item.domain] ?? 0) + 1
  if (item.hasSkip) result.skipFiles += 1
  if (item.externalDependency) result.externalDependencyFiles += 1
  return result
}, { files: 0, declaredTests: 0, skipFiles: 0, externalDependencyFiles: 0, byKind: {}, byLayer: {}, byDomain: {} })

const output = JSON.stringify({ generatedAt: new Date().toISOString(), summary, items }, null, 2)
if (outputPath) fs.writeFileSync(path.resolve(root, outputPath), `${output}\n`)
console.log(output)
