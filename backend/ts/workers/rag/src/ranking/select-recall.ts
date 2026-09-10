import type { RagDocument, RagSearchResult } from "../../../../packages/contracts/src/rag.ts";
import { compact, digest, similarity, tokenSet } from "./helpers.ts";
import type { UnifiedRecallOptions, UnifiedRecallOutput } from "./types.ts";

export function selectUnifiedRecall(
  candidates: Array<{ result: RagSearchResult; document: RagDocument }>,
  options: UnifiedRecallOptions = {},
): UnifiedRecallOutput {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 5), 50));
  const maxChars = Math.max(1, Number(options.maxChars ?? 3000));
  const maxPerSource = Math.max(1, Number(options.maxPerSource ?? 3));
  const maxPerParent = Math.max(1, Number(options.maxPerParent ?? 3));
  const selected: RagDocument[] = [];
  const hashes = new Set<string>();
  const parentCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const selectedTokens: Set<string>[] = [];
  let outputChars = 0;
  let rejectedDuplicate = 0;
  let rejectedParent = 0;
  let rejectedSource = 0;
  let rejectedSimilarity = 0;
  // 主动 search_memory 已经由 rankCandidates 按最终分数完成 Top-K 截断，
  // 不再用来源/父文档/相似度配额替模型做第二次相关性筛选。被动 RAG
  // 仍保留这些多样性约束，避免自动注入被同源内容占满。
  const diversityLimited = options.selectionMode !== "top_k";

  const ordered = [...candidates].sort(
    (left, right) => right.result.score - left.result.score || left.result.id.localeCompare(right.result.id),
  );
  for (const { document } of ordered) {
    const text = String(document.context_text || document.text || "").trim();
    const primaryText = String(document.text || "").trim();
    if (!text) continue;
    const hash = digest(compact(primaryText));
    if (hashes.has(hash)) {
      rejectedDuplicate += 1;
      continue;
    }
    const parent = document.parent_id || document.id;
    if (diversityLimited && (parentCounts.get(parent) ?? 0) >= maxPerParent) {
      rejectedParent += 1;
      continue;
    }
    if (diversityLimited && (sourceCounts.get(document.source_type) ?? 0) >= maxPerSource) {
      rejectedSource += 1;
      continue;
    }
    const tokens = tokenSet(document);
    if (diversityLimited && selectedTokens.some((previous) => similarity(tokens, previous) >= 0.85)) {
      rejectedSimilarity += 1;
      continue;
    }
    const remaining = maxChars - outputChars;
    if (remaining <= 0) break;
    const next = text.length > remaining
      ? { ...document, context_text: text.slice(0, remaining).trimEnd() }
      : document;
    if (!next.text) continue;
    selected.push(next);
    hashes.add(hash);
    selectedTokens.push(tokens);
    parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
    sourceCounts.set(document.source_type, (sourceCounts.get(document.source_type) ?? 0) + 1);
    outputChars += String(next.context_text || next.text || "").length;
    if (selected.length >= limit) break;
  }

  return {
    results: selected,
    has_more: ordered.length > selected.length,
    diagnostics: {
      candidate_count: ordered.length,
      accepted_count: selected.length,
      rejected_duplicate: rejectedDuplicate,
      rejected_parent: rejectedParent,
      rejected_source: rejectedSource,
      rejected_similarity: rejectedSimilarity,
      output_chars: outputChars,
    },
  };
}
