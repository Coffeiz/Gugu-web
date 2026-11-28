/** 统一评分/排序门面；算法实现集中位于 ranking。 */
export type {
  UnifiedRecallDiagnostics,
  UnifiedRecallOptions,
  UnifiedRecallOutput,
} from "./ranking/types.js";
export { rankCandidates } from "./ranking/rank-candidates.js";
export { selectUnifiedRecall } from "./ranking/select-recall.js";
