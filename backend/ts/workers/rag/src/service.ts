/** 统一评分/排序门面；算法实现分别位于 scorer 与 ranker。 */
export type {
  UnifiedRecallDiagnostics,
  UnifiedRecallOptions,
  UnifiedRecallOutput,
} from "./ranker/types.ts";
export { rankCandidates } from "./ranker/rank-candidates.ts";
export { selectUnifiedRecall } from "./ranker/select-recall.ts";
