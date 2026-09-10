import assert from "node:assert/strict";
import test from "node:test";
import {
  SCORING_THRESHOLDS,
  V4_PREFERRED_THRESHOLD,
  V4_LOW_SCORE_THRESHOLD,
  sourceQualityV4,
} from "../src/ranking/confidence.ts";
import { CONTRIBUTION_EXPONENT } from "../src/ranking/idf-rescore.ts";
import { rankCandidates } from "../src/ranking/rank-candidates.ts";
import type { RagRankCandidate } from "../../../packages/contracts/src/rag.ts";

function candidate(id: string, sourceType: string, rawScore: number, text: string): RagRankCandidate {
  return {
    id,
    source_type: sourceType,
    raw_score: rawScore,
    fusion: "bm25",
    document: {
      id,
      text,
      content: text,
      source_type: sourceType,
      source_id: id,
      title: id,
      scope_type: "owner",
      scope_id: "",
      document_version: "1",
      parent_id: id,
      chunk_index: 0,
      chunk_count: 1,
      metadata: {},
    },
  } as unknown as RagRankCandidate;
}

test("v4 生产口径常量：阈值 0.55/0.35、指数 1.5、来源质量表", () => {
  assert.equal(V4_PREFERRED_THRESHOLD, 0.55);
  assert.equal(V4_LOW_SCORE_THRESHOLD, 0.35);
  assert.equal(CONTRIBUTION_EXPONENT, 1.5);
  assert.equal(sourceQualityV4("knowledge"), 1.0);
  for (const source of ["memory", "project", "file", "journal", "note", "calendar"]) {
    assert.equal(sourceQualityV4(source), 0.8, source);
  }
  for (const source of ["canvas", "conversation", "scheduled_task", "unknown"]) {
    assert.equal(sourceQualityV4(source), 0.6, source);
  }
  assert.equal(SCORING_THRESHOLDS["confidence-v1"].preferred, 0.55);
});

test("默认按 confidence-v4 交付：排序、阈值与诊断版本", () => {
  const candidates = [
    candidate("k:1", "knowledge", 10, "蒙扎赛道 t6 弯道名称知识正文"),
    candidate("c:1", "conversation", 6, "蒙扎 t6 聊天记录"),
    candidate("m:1", "memory", 4, "完全无关的生活碎片内容"),
  ];
  const { results, diagnostics } = rankCandidates("蒙扎 t6 弯道", candidates, {
    limit: 2,
    selectionMode: "confidence",
  });
  assert.equal(diagnostics.scoring_version, "confidence-v4");
  assert.equal(diagnostics.preferred_threshold, 0.55);
  assert.equal(diagnostics.threshold, 0.35);
  assert.ok(diagnostics.accepted_count >= 1 && diagnostics.accepted_count <= 2);
  for (const item of results) {
    // 乘法公式：上界 = 来源质量。
    assert.ok(item.confidence <= item.source_quality + 1e-9, `${item.id}: ${item.confidence}`);
    assert.ok(item.confidence >= diagnostics.threshold, item.id);
  }
  // band 排他：首选带非空时结果全部来自首选带。
  if ((diagnostics.top_confidence ?? 0) >= 0.55) {
    assert.ok(results.every((item) => item.confidence >= 0.55));
  }
});

test("confidence-v1 回滚开关恢复旧排序语义", () => {
  const candidates = [
    candidate("k:1", "knowledge", 10, "蒙扎赛道 t6 弯道名称知识正文"),
    candidate("c:1", "conversation", 6, "蒙扎 t6 聊天记录"),
  ];
  const v1 = rankCandidates("蒙扎 t6 弯道", candidates, {
    limit: 2, selectionMode: "confidence", scoringVersion: "confidence-v1",
  });
  assert.equal(v1.diagnostics.scoring_version, "confidence-v1");
  assert.equal(v1.diagnostics.preferred_threshold, 0.55);
  // v1 无命中保护语义仍生效：零命中候选 value ≤ 0.34。
  const miss = rankCandidates("毫不相干的查询词", [candidate("c:2", "conversation", 9, "今天吃了个汉堡")], {
    limit: 2, selectionMode: "confidence", scoringVersion: "confidence-v1",
  });
  assert.ok((miss.diagnostics.top_confidence ?? 1) <= 0.34, String(miss.diagnostics.top_confidence));
  assert.equal(miss.results.length, 0);
});

test("v4 零命中候选受无命中保护，不进任何 band", () => {
  const miss = rankCandidates("毫不相干的查询词", [candidate("c:2", "conversation", 9, "今天吃了个汉堡")], {
    limit: 2, selectionMode: "confidence",
  });
  assert.ok((miss.diagnostics.top_confidence ?? 1) <= 0.34, String(miss.diagnostics.top_confidence));
  assert.equal(miss.results.length, 0);
});

test("带完整索引统计时 v4 仍归一化有界（防 rank_score 泄漏回归）", () => {
  const statistics = {
    documentCount: 100,
    averageLength: 6,
    documentFrequency: new Map([["缓存", 5], ["部署", 20]]),
    source: "full_ts_index" as const,
  };
  const docs = [
    candidate("f:1", "file", 10, "缓存文件的部署结论"),
    candidate("f:2", "file", 6, "缓存文件的架构说明"),
  ];
  const { results, diagnostics } = rankCandidates("缓存 部署", docs, {
    limit: 5, selectionMode: "confidence", corpusStatistics: statistics,
  });
  assert.ok(diagnostics.top_confidence <= 1.0, String(diagnostics.top_confidence));
  for (const item of results) {
    assert.ok(item.confidence <= item.source_quality + 1e-9, `${item.id}: ${item.confidence}`);
  }
});
