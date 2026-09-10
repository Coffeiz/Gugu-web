/** 统一评分/排序门面；算法实现集中位于 ranking。 */
export type {
  UnifiedRecallDiagnostics,
  UnifiedRecallOptions,
  UnifiedRecallOutput,
} from "./ranking/types.ts";
export { rankCandidates } from "./ranking/rank-candidates.ts";
export { selectUnifiedRecall } from "./ranking/select-recall.ts";
