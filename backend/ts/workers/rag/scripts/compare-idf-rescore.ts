#!/usr/bin/env node

/** 对比同一候选池的 p=1 / p=2 离线重排结果。只读本地报告，不调用生产 API。 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Row = { id?: string; new_rank?: number; baseline_rank?: number | null };
type QueryReport = { query?: string; top_rows?: Row[]; rows?: Row[] };
type Report = { contribution_exponent?: number; queries?: QueryReport[]; index_revision?: string | null };

function value(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const result = index >= 0 ? argv[index + 1] : "";
  if (!result || result.startsWith("--")) throw new Error(`必须提供 ${name}`);
  return resolve(result);
}

function ids(rows: Row[], limit = rows.length): string[] {
  return rows
    .slice(0, limit)
    .sort((left, right) => (left.new_rank ?? 0) - (right.new_rank ?? 0))
    .map((row) => String(row.id ?? ""));
}

function firstDifference(left: string[], right: string[]): number | null {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index + 1;
  }
  return null;
}

function markdown(report: Record<string, unknown>): string {
  const lines = [
    "# IDF 非线性重排 p=1 / p=2 离线对照",
    "",
    "> 同一完整 TS 索引、同一候选池、同一 query；只比较贡献聚合指数，不改变生产数据。",
    "",
    `- p=1 报告：${report.p1_file}`,
    `- p=2 报告：${report.p2_file}`,
    `- query 数：${report.query_count}`,
    `- Top1 发生变化：${report.top1_changed_count}`,
    `- Top3 集合发生变化：${report.top3_changed_count}`,
    `- p=1 → p=2 首个差异位置：${report.first_difference_position ?? "无"}`,
    "",
    "| Query | p=1 Top1 | p=2 Top1 | 首个差异 | p=1 Top3 | p=2 Top3 |",
    "|---|---|---|---:|---|---|",
  ];
  for (const item of report.queries as Array<Record<string, unknown>>) {
    lines.push(`| ${item.query} | ${item.p1_top1 ?? "-"} | ${item.p2_top1 ?? "-"} | ${item.first_difference_position ?? "—"} | ${(item.p1_top3 as string[]).join(" / ")} | ${(item.p2_top3 as string[]).join(" / ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const p1File = value(argv, "--p1");
  const p2File = value(argv, "--p2");
  const output = value(argv, "--output");
  const [p1, p2] = await Promise.all([
    readFile(p1File, "utf8").then((text) => JSON.parse(text) as Report),
    readFile(p2File, "utf8").then((text) => JSON.parse(text) as Report),
  ]);
  const p1Queries = new Map((p1.queries ?? []).map((query) => [String(query.query ?? ""), query]));
  const p2Queries = new Map((p2.queries ?? []).map((query) => [String(query.query ?? ""), query]));
  const queryNames = [...new Set([...p1Queries.keys(), ...p2Queries.keys()])];
  let top1Changed = 0;
  let top3Changed = 0;
  let firstDifferencePosition: number | null = null;
  const queries = queryNames.map((query) => {
    const left = p1Queries.get(query);
    const right = p2Queries.get(query);
    const p1Rows = left?.rows ?? left?.top_rows ?? [];
    const p2Rows = right?.rows ?? right?.top_rows ?? [];
    const p1All = ids(p1Rows);
    const p2All = ids(p2Rows);
    const p1Top3 = ids(p1Rows, 3);
    const p2Top3 = ids(p2Rows, 3);
    const changed = p1All[0] !== p2All[0];
    const top3ChangedHere = p1Top3.join("\n") !== p2Top3.join("\n");
    if (changed) top1Changed += 1;
    if (top3ChangedHere) top3Changed += 1;
    const difference = firstDifference(p1All, p2All);
    if (difference !== null && (firstDifferencePosition === null || difference < firstDifferencePosition)) firstDifferencePosition = difference;
    return { query, p1_top1: p1All[0] ?? null, p2_top1: p2All[0] ?? null, first_difference_position: difference, p1_top3: p1Top3, p2_top3: p2Top3 };
  });
  const report = {
    generated_at: new Date().toISOString(),
    p1_file: p1File,
    p2_file: p2File,
    index_revision: p2.index_revision ?? p1.index_revision ?? null,
    p1_exponent: p1.contribution_exponent ?? 1,
    p2_exponent: p2.contribution_exponent ?? 2,
    query_count: queryNames.length,
    top1_changed_count: top1Changed,
    top3_changed_count: top3Changed,
    first_difference_position: firstDifferencePosition,
    queries,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownPath = output.replace(/\.json$/u, ".md");
  await writeFile(markdownPath, markdown(report), "utf8");
  console.log(JSON.stringify({ output, markdown: markdownPath, query_count: queryNames.length, top1_changed_count: top1Changed, top3_changed_count: top3Changed }, null, 2));
}

await main();
