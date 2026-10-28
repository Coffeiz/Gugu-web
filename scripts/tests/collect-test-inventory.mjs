#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../..')
const workflowDirectory = path.join(root, '.github/workflows')
const workflow = fs.readdirSync(workflowDirectory)
  .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map(file => fs.readFileSync(path.join(workflowDirectory, file), 'utf8'))
  .join('\n')
const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'frontend/package.json'), 'utf8'))
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
  const backendTestCategory = value.match(/^backend\/tests\/([^/]+)(?:\/([^/]+))?\//)
  const category = backendTestCategory?.[2]
    ? `${backendTestCategory[1]}/${backendTestCategory[2]}`
    : backendTestCategory?.[1]
  const backendCategoryDomains = {
    agent: 'agent-provider',
    'agent/chat': 'im',
    'agent/context': 'context',
    'agent/knowledge': 'memory-rag',
    'agent/mcp': 'agent-provider',
    'agent/memory': 'memory-rag',
    'agent/providers': 'agent-provider',
    'agent/rag': 'memory-rag',
    'platform/admin': 'security',
    'platform/auth': 'security',
    'platform/deployment': 'deployment',
    'platform/email': 'im',
    'platform/observability': 'terminal-runtime',
    'platform/preferences': 'agent-provider',
    'platform/realtime': 'realtime',
    'platform/security': 'security',
    'platform/usage': 'agent-provider',
    'platform/utilities': 'other',
    'scheduling/calendar': 'schedule',
    'scheduling/events': 'schedule',
    'scheduling/tasks': 'schedule',
    'storage/data_portability': 'data-portability',
    'storage/files': 'storage',
    'storage/filesync': 'filesync',
    'storage/trash': 'storage',
    im: 'im',
    'im/feishu': 'im',
    'im/qq': 'im',
    'im/telegram': 'im',
    filesync: 'filesync',
    storage: 'storage',
    projects: 'mind-project',
    mind: 'mind-project',
    terminal: 'terminal-runtime',
    media: 'storage',
  }
  if (category && backendCategoryDomains[category]) {
    return backendCategoryDomains[category]
  }
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
  if (['diagnostic-script', 'benchmark-script', 'smoke-script', 'test-support'].includes(kind)) return 'L2'
  if (value.includes('docker') || value.includes('pty') || value.includes('raw_ws') || value.includes('terminal_streaming')) return 'L2'
  if (value.includes('/scripts/') && !value.includes('/tests/')) return 'L0'
  if (['vitest', 'static-check', 'test-governance'].includes(kind)) return 'L0'
  return 'L1'
}

function ownerFor(file, kind, domain) {
  if (kind === 'playwright') return 'frontend/e2e'
  if (kind === 'static-check') return '工程质量'
  if (kind === 'diagnostic-script') return 'backend/diagnostics'
  if (kind === 'benchmark-script') return 'backend/benchmarks'
  if (kind === 'smoke-script') return 'backend/smoke'
  if (kind === 'test-support') return '测试环境辅助'
  if (kind === 'test-governance') return '测试治理'
  if (kind === 'node-test') return file.startsWith('loopscope/') ? 'loopscope/runtime' : 'backend/ts'
  if (kind === 'vitest') return `frontend/${domain}`
  return `backend/${domain}`
}

function inventoryItem(file, kind) {
  const source = read(file)
  const runnableSource = executableSource(source)
  const isE2e = kind === 'playwright'
  const isManualAsset = ['diagnostic-script', 'benchmark-script', 'smoke-script', 'static-check', 'test-support', 'test-governance'].includes(kind)
  const declaredTestCount = isManualAsset
    ? 0
    : isE2e
      ? countMatches(source, /\b(test|test\.describe)\s*\(/g)
      : kind === 'pytest'
        ? countMatches(source, /^\s*(?:async\s+)?def\s+test_[A-Za-z0-9_]+\s*\(/gm)
        : countMatches(source, /\b(?:it|test)(?:\.each|\.skip|\.only)?\s*\(/g)
  const ci = isE2e
    ? workflow.includes('test:e2e:stable') && frontendPackage.scripts?.['test:e2e:stable']?.includes(path.basename(file))
    : kind === 'vitest'
      ? workflow.includes('pnpm --filter gugu-web run test:run') || workflow.includes('pnpm --filter gugu-web test:run')
      : kind === 'node-test'
        ? file.startsWith('loopscope/apps/collector/')
          ? workflow.includes('pnpm test') && workflow.includes('working-directory: loopscope')
          : workflow.includes(path.basename(file))
        : ['diagnostic-script', 'benchmark-script', 'smoke-script'].includes(kind)
          ? false
          : kind === 'test-support'
            ? workflow.includes(path.basename(file))
          : kind === 'pytest'
            ? file.startsWith('scripts/licenses/tests/')
              ? workflow.includes('scripts/licenses/tests')
              : workflow.includes('pytest -q')
            : kind === 'test-governance'
              ? workflow.includes(path.basename(file))
              : kind === 'static-check'
                ? workflow.includes(path.basename(file))
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
  ...Array.from(new Set([
    ...gitFiles('backend/tests/test_*.py'),
    ...gitFiles('backend/tests/**/test_*.py'),
    ...gitFiles('scripts/release/test_*.py'),
    ...gitFiles('scripts/quality/test_*.py'),
    ...gitFiles('scripts/licenses/tests/test_*.py'),
  ])).map(file => inventoryItem(file, 'pytest')),
  ...gitFiles('backend/scripts/diagnostics').filter(file => /\.(py|ts|mjs)$/.test(file)).map(file => inventoryItem(file, 'diagnostic-script')),
  ...gitFiles('backend/scripts/benchmarks').filter(file => /\.(py|ts|mjs)$/.test(file)).map(file => inventoryItem(file, 'benchmark-script')),
  ...gitFiles('backend/scripts/smoke').filter(file => /\.(py|ts|mjs)$/.test(file)).map(file => inventoryItem(file, 'smoke-script')),
  ...gitFiles('backend/scripts/testing').filter(file => /\.(py|ts|mjs)$/.test(file)).map(file => inventoryItem(file, 'test-support')),
  ...gitFiles('backend/scripts/checks').filter(file => /\.(py|ts|mjs)$/.test(file)).map(file => inventoryItem(file, 'static-check')),
  ...gitFiles('backend/ts').filter(file => /\.test\.(ts|mjs)$/.test(file)).map(file => inventoryItem(file, 'node-test')),
  ...gitFiles('loopscope').filter(file => /\.test\.(ts|mjs)$/.test(file)).map(file => inventoryItem(file, 'node-test')),
  ...gitFiles('scripts/release').filter(file => /\.test\.mjs$/.test(file)).map(file => inventoryItem(file, 'node-test')),
  ...gitFiles('frontend/tests').filter(file => file.endsWith('.test.ts')).map(file => inventoryItem(file, 'vitest')),
  ...gitFiles('frontend/e2e/*.spec.ts').map(file => inventoryItem(file, 'playwright')),
  ...gitFiles('frontend/scripts').filter(file => /\/check-[^/]+\.mjs$/.test(file)).map(file => inventoryItem(file, 'static-check')),
  ...gitFiles('scripts/licenses').filter(file => /\/check-[^/]+\.mjs$/.test(file)).map(file => inventoryItem(file, 'static-check')),
  ...gitFiles('scripts/tests').filter(file => /\/(check-|run-test-|run-fast-)[^/]+\.mjs$/.test(file)).map(file => inventoryItem(file, 'test-governance')),
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
