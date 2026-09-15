import assert from "node:assert/strict";
import test from "node:test";
import { scoreTerms, tokenize } from "../src/ranking/bm25.ts";
import { tokenizeRaw } from "../src/tokenizer.ts";
import type { ScoringCorpus } from "../src/ranking/types.ts";

test("ISO 日期与中文、英文月份共享规范月份词项", () => {
  const indexedDateTokens = tokenizeRaw("2026-09-01 记录了这件事");

  assert.ok(indexedDateTokens.includes("month_09"));
  for (const query of ["9月", "09月份", "九月", "九月份", "Sep", "Sept", "September", "2026年9月"]) {
    assert.ok(tokenizeRaw(query).includes("month_09"), `${query} 应归一化为 month_09`);
  }
  assert.ok(!tokenizeRaw("九月").includes("2026"), "月份归一化不能擅自补年份");
});

test("月份别名通过 BM25 命中 ISO 日期记忆，而不会命中其他月份", () => {
  const corpus = {
    documents: [{ id: "september" }, { id: "august" }],
    postings: new Map([
      ["month_09", { ids: ["september"], frequencies: [1] }],
      ["month_08", { ids: ["august"], frequencies: [1] }],
    ]),
    lengths: new Map([["september", 3], ["august", 3]]),
    docFreq: new Map([["month_09", 1], ["month_08", 1]]),
    avgLength: 3,
  } as unknown as ScoringCorpus;

  const scores = scoreTerms(corpus, new Set(tokenize("9月")));

  assert.ok((scores.get("september") ?? 0) > 0);
  assert.ok(!scores.has("august"));
  assert.ok((scoreTerms(corpus, new Set(tokenize("Sep"))).get("september") ?? 0) > 0);
});

test("May 与 March 仅在日期语境中视为月份，避免普通英语词产生日期命中", () => {
  assert.ok(!tokenizeRaw("you may want to check").includes("month_05"));
  assert.ok(tokenizeRaw("May 2026").includes("month_05"));
  assert.ok(!tokenizeRaw("we march forward").includes("month_03"));
  assert.ok(tokenizeRaw("March 2026").includes("month_03"));
});
