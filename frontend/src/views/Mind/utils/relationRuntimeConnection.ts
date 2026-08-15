import type { NodeConnectionEndpoint } from '@/interaction/runtime'
import type { RelationAnchorSides } from '@/composables/useMindCanvas'

export function createRelationRuntimeConnection(
  sides: RelationAnchorSides | undefined,
  sourceObjectId: string | null,
  targetObjectId: string | null,
): NodeConnectionEndpoint | null {
  if (!sides || !sourceObjectId || !targetObjectId) return null
  return {
    sourceObjectId,
    sourcePortId: sides.srcSide,
    targetObjectId,
    targetPortId: sides.dstSide,
  }
}
