import { compileContextFragments } from '../../context/fragment-plan.js'
import type { CanonicalMessage } from '../../models.js'
import type { ContextSourcePorts } from '../../ports.js'

type MainBuilder = ContextSourcePorts['builder']

/** 旧 builder 负责宿主格式化，场景负责分区并投影回已有快照及请求契约。 */
function assembleMainPrefix(systemPrompt: string, snapshot: string): { systemPrompt: string; snapshot: string }
function assembleMainPrefix(systemPrompt: string, snapshot: CanonicalMessage[]): { systemPrompt: string; snapshot: CanonicalMessage[] }
function assembleMainPrefix(systemPrompt: string, snapshot: string | CanonicalMessage[]) {
  const compiled = compileContextFragments<string | CanonicalMessage[]>([
    { id: 'main.instructions', version: 1, region: 'system', kind: 'instruction', value: systemPrompt },
    { id: 'main.snapshot', version: 1, region: 'snapshot', kind: 'data', value: snapshot },
  ])
  return { systemPrompt: compiled.system[0]!.value, snapshot: compiled.snapshot[0]!.value }
}

export function createMainContextBuilder(builder: MainBuilder): MainBuilder {
  return {
    buildSnapshot(data, selection, identity) {
      const payload = builder.buildSnapshot(data, selection, identity)
      const prefix = assembleMainPrefix(payload.systemPrompt, payload.snapshotContext)
      return { ...payload, systemPrompt: prefix.systemPrompt, snapshotContext: prefix.snapshot }
    },
    buildRequest(snapshot, selection, identity) {
      const request = builder.buildRequest(snapshot, selection, identity)
      const prefix = assembleMainPrefix(request.systemPrompt, request.fixedPrefix)
      return { ...request, systemPrompt: prefix.systemPrompt, fixedPrefix: prefix.snapshot }
    },
  }
}
