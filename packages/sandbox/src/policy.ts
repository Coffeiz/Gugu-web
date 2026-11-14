import { ExecutionError } from './contracts.js'
import type {
  ExecutionCapabilities,
  ExecutionGrant,
  ExecutionPolicy,
  ExecutionRequest,
} from './contracts.js'

export function executionPolicy(
  request: ExecutionRequest,
  grant: ExecutionGrant,
  capabilities: ExecutionCapabilities,
): ExecutionPolicy {
  if (
    !request ||
    !grant ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.id) ||
    grant.requestId !== request.id ||
    request.command !== grant.command ||
    request.cwd !== grant.cwd ||
    typeof request.destructive !== 'boolean' ||
    typeof grant.confirmed !== 'boolean' ||
    !Array.isArray(grant.readonlyPaths) ||
    !Array.isArray(grant.readwritePaths) ||
    !grant.environment ||
    typeof grant.environment !== 'object' ||
    Array.isArray(grant.environment)
  )
    throw new ExecutionError('denied', '执行请求与可信授权不匹配')
  if (request.destructive && !grant.confirmed)
    throw new ExecutionError('denied', '破坏性执行需要确认')
  if (
    typeof request.command !== 'string' ||
    !request.command.trim() ||
    request.command.length > 16_384 ||
    request.command.includes('\0') ||
    typeof request.cwd !== 'string' ||
    !request.cwd ||
    request.cwd.includes('\0')
  )
    throw new ExecutionError('denied', '执行参数无效')
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    !Number.isSafeInteger(grant.timeoutMs) ||
    grant.timeoutMs < request.timeoutMs ||
    grant.timeoutMs > 300_000 ||
    !Number.isSafeInteger(grant.maxOutputBytes) ||
    grant.maxOutputBytes < 1 ||
    grant.maxOutputBytes > 1_048_576
  )
    throw new ExecutionError('denied', '执行时间或输出限制无效')
  if (
    !capabilities.filesystem ||
    !capabilities.networkDeny ||
    !capabilities.uiDeny ||
    !capabilities.timeout ||
    !capabilities.cancellation
  )
    throw new ExecutionError('unsupported', '原生后端无法落实所需隔离策略')
  const paths = [...grant.readonlyPaths, ...grant.readwritePaths]
  if (
    !paths.length ||
    paths.length > 64 ||
    paths.some((path) => typeof path !== 'string' || !path || path.includes('\0')) ||
    Object.entries(grant.environment).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof value !== 'string' ||
        value.includes('\0') ||
        /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(key),
    )
  )
    throw new ExecutionError('denied', 'Host 授权资源或环境无效')
  return Object.freeze({
    ...grant,
    timeoutMs: request.timeoutMs,
    readonlyPaths: Object.freeze([...grant.readonlyPaths]),
    readwritePaths: Object.freeze([...grant.readwritePaths]),
    environment: Object.freeze({ ...grant.environment }),
  })
}
