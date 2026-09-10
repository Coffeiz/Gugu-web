#!/usr/bin/env node

/**
 * 离线测试“全量 token + IDF 加权”重排算法。
 *
 * 该脚本只重排已有诊断报告中的候选池，不会改变召回，也不会调用生产 API。
 * 输入报告通常来自 rag_idf_rescore_probe 的旧算法结果；完整 TS 索引用于复用
 * 生产 tokenizer、BM25 参数和 IDF 统计。
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tokenizeRaw } from "../src/tokenizer.ts";

const K1 = 1.2;
const B = 0.75;

type JsonObject = Record<string, unknown>;

type IndexDocument = {
  id: string;
  text?: string;
};

type IndexFile = {
  version?: string;
  revision?: string;
  documents?: IndexDocument[];
};

type CandidateRow = {
  id?: string;
  source_type?: string;
  title?: string;
  content?: string;
  baseline_rank?: number;
  base_score?: number;
  base_score_source?: string;
  [key: string]: unknown;
};

type QueryReport = {
  query?: string;
  rows?: CandidateRow[];
  [key: string]: unknown;
};

type CorpusStats = {
  documentCount: number;
  averageLength: number;
  documentFrequency: Map<string, number>;
  idf: Map<string, number>;
};

type TermInfo = {
  term: string;
  idf: number | null;
  weight: number;
  indexed: boolean;
};

type CandidateScore = {
  id: string;
  source_type: string;
  title: string;
  baseline_rank: number | null;
  baseline_score: number | null;
  recomputed_bm25: number;
  rank_score: number;
  rank_delta: number | null;
  matched_terms: string[];
  contributions: Array<{
    term: string;
    idf: number;
    weight: number;
    tf: number;
    bm25_contribution: number;
    weighted_contribution: number;
    nonlinear_contribution: number;
  }>;
  content?: string;
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function termFrequency(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return frequencies;
}

function buildCorpusStats(index: IndexFile): CorpusStats {
  const documents = index.documents ?? [];
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const document of documents) {
    const frequencies = termFrequency(tokenizeRaw(asString(document.text)));
    totalLength += [...frequencies.values()].reduce((sum, count) => sum + count, 0);
    for (const term of frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const documentCount = documents.length;
  const idf = new Map<string, number>();
  for (const [term, frequency] of documentFrequency) {
    idf.set(term, Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5)));
  }
  return {
    documentCount,
    averageLength: documentCount ? totalLength / documentCount : 0,
    documentFrequency,
    idf,
  };
}

function queryTerms(query: string, stats: CorpusStats, exponent: number, maxWeight: number): {
  all: string[];
  indexed: TermInfo[];
  baseline: number;
} {
  const all = [...new Set(tokenizeRaw(query))];
  const indexedIdfs = all
    .map((term) => stats.idf.get(term))
    .filter((value): value is number => value !== undefined);
  const baseline = indexedIdfs.length
    ? indexedIdfs.reduce((sum, value) => sum + value, 0) / indexedIdfs.length
    : 0;

  const terms = all.map((term): TermInfo => {
    const idf = stats.idf.get(term);
    if (idf === undefined || baseline <= 0) {
      return { term, idf: idf ?? null, weight: 0, indexed: idf !== undefined };
    }
    // 不删除任何 query token；权重只由该 token 的 corpus IDF 相对本 query 的均值决定。
    const weight = Math.min(maxWeight, Math.max(0.25, Math.pow(idf / baseline, exponent)));
    return { term, idf, weight, indexed: true };
  });
  return {
    all,
    indexed: terms.filter((term) => term.indexed && term.idf !== null),
    baseline,
  };
}

function scoreCandidate(
  candidate: CandidateRow,
  terms: TermInfo[],
  stats: CorpusStats,
  baselineRank: number | null,
  includeContent: boolean,
  contributionExponent: number,
): CandidateScore {
  const content = asString(candidate.content);
  const frequencies = termFrequency(tokenizeRaw(content));
  const length = Math.max(1, [...frequencies.values()].reduce((sum, count) => sum + count, 0));
  const averageLength = stats.averageLength || 1;
  let recomputedBm25 = 0;
  let rankScore = 0;
  const contributions: CandidateScore["contributions"] = [];

  for (const term of terms) {
    if (term.idf === null || term.weight <= 0) continue;
    const tf = frequencies.get(term.term) ?? 0;
    if (!tf) continue;
    const norm = tf + K1 * (1 - B + B * length / averageLength);
    const bm25Contribution = term.idf * tf * (K1 + 1) / norm;
    const weightedContribution = bm25Contribution * term.weight;
    const nonlinearContribution = Math.pow(weightedContribution, contributionExponent);
    recomputedBm25 += bm25Contribution;
    rankScore += nonlinearContribution;
    contributions.push({
      term: term.term,
      idf: term.idf,
      weight: term.weight,
      tf,
      bm25_contribution: bm25Contribution,
      weighted_contribution: weightedContribution,
      nonlinear_contribution: nonlinearContribution,
    });
  }

  contributions.sort((left, right) => right.weighted_contribution - left.weighted_contribution || left.term.localeCompare(right.term));
  return {
    id: asString(candidate.id),
    source_type: asString(candidate.source_type),
    title: asString(candidate.title),
    baseline_rank: baselineRank,
    baseline_score: asNumber(candidate.base_score),
    recomputed_bm25: recomputedBm25,
    rank_score: rankScore,
    rank_delta: null,
    matched_terms: contributions.map((item) => item.term),
    contributions,
    ...(includeContent ? { content } : {}),
  };
}

function sortedCandidates(rows: CandidateScore[]): CandidateScore[] {
  return [...rows].sort((left, right) =>
    right.rank_score - left.rank_score || left.id.localeCompare(right.id));
}

function parseArgs(argv: string[]): {
  input: string;
  index: string;
  output: string;
  topK: number;
  exponent: number;
  maxWeight: number;
  contributionExponent: number;
  includeContent: boolean;
  topOnly: boolean;
  fullCorpus: boolean;
  allowLocalData: boolean;
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--") && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values.set(value, argv[index + 1]);
      index += 1;
    } else if (value.startsWith("--")) {
      flags.add(value);
    }
  }
  const input = values.get("--input") ?? "";
  const index = values.get("--index") ?? "";
  const output = values.get("--output") ?? "";
  if (!input || !index || !output) {
    throw new Error("必须提供 --input、--index 和 --output；真实本地数据还需要 --allow-local-data");
  }
  if (!flags.has("--allow-local-data")) {
    throw new Error("这是非脱敏离线诊断，必须显式传入 --allow-local-data");
  }
  return {
    input: resolve(input),
    index: resolve(index),
    output: resolve(output),
    topK: Number(values.get("--top-k") ?? 10),
    exponent: Number(values.get("--idf-exponent") ?? 1),
    maxWeight: Number(values.get("--max-weight") ?? 4),
    contributionExponent: Number(values.get("--contribution-exponent") ?? 1),
    includeContent: flags.has("--include-content"),
    topOnly: flags.has("--top-only"),
    fullCorpus: flags.has("--full-corpus"),
    allowLocalData: true,
  };
}

function markdown(report: JsonObject): string {
  const lines: string[] = [
    "# 全量 Token + IDF 加权重排离线测试",
    "",
    "> 本报告只重排输入报告已有的候选池，不代表生产排序已启用。",
    "> 所有 query token 都保留；低 IDF token 只通过较低权重自然落后，不做 token 过滤。",
    "",
    `- IDF 指数：${report.idf_exponent}`,
    `- 最大 IDF 权重：${report.max_weight}`,
    `- 贡献非线性指数：${report.contribution_exponent}`,
    `- 选择策略：${report.selection_mode}`,
    `- 候选来源：${report.candidate_source}`,
    `- 索引文档数：${report.index_document_count}`,
    `- 查询数：${report.query_count}`,
    `- 总排序变化：${report.total_moved_count}`,
  ];

  for (const query of report.queries as Array<JsonObject>) {
    lines.push("", `## ${asString(query.query)}`, "");
    lines.push(`- query tokens：${(query.query_terms as Array<JsonObject>).map((term) => `${term.term}(idf=${term.idf ?? "未索引"}, weight=${Number(term.weight).toFixed(3)})`).join(" / ")}`);
    lines.push(`- query IDF 均值：${Number(query.query_idf_baseline).toFixed(4)}`);
    lines.push(`- Top1：${query.baseline_top_id ?? "-"} → ${query.rescored_top_id ?? "-"}`);
    lines.push("", "| 新排名 | 原排名 | Δ | 来源 | 标题 | 原分 | 重排分 | 命中 token | 逐项贡献 |", "|---:|---:|---:|---|---|---:|---:|---|---|");
    for (const row of (query.top_rows as Array<JsonObject>)) {
      const delta = row.rank_delta === null ? "—" : `${Number(row.rank_delta) > 0 ? "↑" : "↓"}${Math.abs(Number(row.rank_delta))}`;
      const contributions = (row.contributions as Array<JsonObject>)
        .map((item) => `${item.term}=${Number(item.nonlinear_contribution ?? item.weighted_contribution).toFixed(3)}`).join("; ");
      lines.push(`| ${row.new_rank} | ${row.baseline_rank ?? "-"} | ${delta} | ${row.source_type} | ${String(row.title).replaceAll("|", "\\|")} | ${Number(row.baseline_score ?? 0).toFixed(3)} | ${Number(row.rank_score).toFixed(3)} | ${(row.matched_terms as string[]).join(", ") || "无"} | ${contributions || "无"} |`);
    }
    for (const row of (query.top_rows as Array<JsonObject>)) {
      if (typeof row.content !== "string") continue;
      lines.push(
        "",
        `### ${row.new_rank}. ${String(row.source_type)} / ${String(row.title)}`,
        "",
        "```text",
        row.content,
        "```",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [inputText, indexText] = await Promise.all([
    readFile(args.input, "utf8"),
    readFile(args.index, "utf8"),
  ]);
  const input = JSON.parse(inputText) as JsonObject;
  const index = JSON.parse(indexText) as IndexFile;
  const stats = buildCorpusStats(index);
  const queries = Array.isArray(input.queries) ? input.queries as QueryReport[] : [];
  const outputQueries: JsonObject[] = [];
  let totalMoved = 0;

  for (const query of queries) {
    const text = asString(query.query);
    const queryInfo = queryTerms(text, stats, args.exponent, args.maxWeight);
    const rows = args.fullCorpus
      ? (index.documents ?? []).map((document): CandidateRow => ({
        id: document.id,
        source_type: asString((document as JsonObject).source_type),
        title: asString((document as JsonObject).title),
        content: asString(document.text),
      }))
      : (Array.isArray(query.rows) ? query.rows : []);
    const baselineRows = args.fullCorpus
      ? []
      : rows.map((row, indexInRows) => ({ row, indexInRows }))
        .sort((left, right) => (asNumber(left.row.baseline_rank) ?? left.indexInRows + 1) - (asNumber(right.row.baseline_rank) ?? right.indexInRows + 1));
    const baselineRanks = new Map<string, number>();
    baselineRows.forEach(({ row }, indexInRows) => baselineRanks.set(asString(row.id) || `row-${indexInRows}`, asNumber(row.baseline_rank) ?? indexInRows + 1));

    const scored = rows.map((row, indexInRows) => scoreCandidate(
      row,
      queryInfo.indexed,
      stats,
      args.fullCorpus
        ? null
        : baselineRanks.get(asString(row.id) || `row-${indexInRows}`) ?? indexInRows + 1,
      args.includeContent,
      args.contributionExponent,
    ));
    const ranked = sortedCandidates(scored);
    const newRanks = new Map(ranked.map((row, indexInRows) => [row.id, indexInRows + 1]));
    const withDeltas = ranked.map((row) => {
      const baselineRank = row.baseline_rank;
      const newRank = newRanks.get(row.id) ?? 0;
      const rankDelta = baselineRank === null ? null : baselineRank - newRank;
      if (rankDelta) totalMoved += 1;
      return { ...row, rank_delta: rankDelta, new_rank: newRank };
    });
    outputQueries.push({
      query: text,
      query_tokens: queryInfo.all,
      query_terms: queryInfo.all.map((term) => {
        const info = queryInfo.indexed.find((item) => item.term === term);
        return { term, idf: info?.idf ?? null, weight: info?.weight ?? 0, indexed: Boolean(info) };
      }),
      query_idf_baseline: queryInfo.baseline,
      candidate_count: scored.length,
      selected_count: args.topOnly ? Math.min(args.topK, withDeltas.length) : withDeltas.length,
      baseline_top_id: baselineRows[0]?.row.id ?? null,
      rescored_top_id: withDeltas[0]?.id ?? null,
      top_rows: withDeltas.slice(0, args.topK),
      rows: args.topOnly ? withDeltas.slice(0, args.topK) : withDeltas,
    });
  }

  const report: JsonObject = {
    generated_at: new Date().toISOString(),
    input_file: args.input,
    index_file: args.index,
    algorithm: "per-term BM25 contribution × bounded relative IDF weight × nonlinear contribution; no token filtering",
    selection_mode: `score_top_${args.topK}_no_confidence_filter`,
    candidate_source: args.fullCorpus ? "full_ts_index" : "input_report_candidate_pool",
    idf_exponent: args.exponent,
    max_weight: args.maxWeight,
    contribution_exponent: args.contributionExponent,
    tokenizer: "TS tokenizeRaw",
    bm25: { k1: K1, b: B },
    index_revision: index.revision ?? null,
    index_document_count: stats.documentCount,
    query_count: outputQueries.length,
    total_moved_count: totalMoved,
    queries: outputQueries,
  };
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownPath = args.output.replace(/\.json$/u, ".md");
  await writeFile(markdownPath, markdown(report), "utf8");
  console.log(JSON.stringify({ output: args.output, markdown: markdownPath, query_count: outputQueries.length, total_moved_count: totalMoved }, null, 2));
}

await main();
