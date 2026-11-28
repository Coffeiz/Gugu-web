import type { NodeConnectionEndpoint } from '@/interaction/runtime'

export type RelationRuntimeRegistry = Record<string, NodeConnectionEndpoint>

export function setRelationRuntimeConnection(
  registry: RelationRuntimeRegistry,
  relationId: number,
  connection: NodeConnectionEndpoint,
): RelationRuntimeRegistry {
  return { ...registry, [String(relationId)]: connection }
}

export function takeRelationRuntimeConnection(
  registry: RelationRuntimeRegistry,
  relationId: number,
): { registry: RelationRuntimeRegistry; connection: NodeConnectionEndpoint | null } {
  const key = String(relationId)
  const connection = registry[key] ?? null
  if (!connection) return { registry, connection: null }
  const next = { ...registry }
  delete next[key]
  return { registry: next, connection }
}

export function transferRelationRuntimeConnection(
  registry: RelationRuntimeRegistry,
  fromRelationId: number,
  toRelationId: number,
): RelationRuntimeRegistry {
  const connection = registry[String(fromRelationId)]
  if (!connection) return registry
  const next = { ...registry, [String(toRelationId)]: connection }
  delete next[String(fromRelationId)]
  return next
}
