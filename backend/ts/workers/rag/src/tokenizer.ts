/** RAG 原文分词器：Jieba 词边界 + ASCII 实体。 */

import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";

const TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/gu;
const ASCII_RE = /^[\x00-\x7F]+$/u;
const jieba = Jieba.withDict(dict);

function segmentChinese(token: string): string[] {
  return (jieba.cut(token, false) as string[]).filter((word) => /[\u4e00-\u9fff]/u.test(word));
}

/** 只保留 Jieba 中文词和完整 ASCII 实体，去除空格、标点及派生 token。 */
export function tokenizeRaw(text: string): string[] {
  const normalized = (text || "").toLocaleLowerCase();
  const raw = (normalized.match(TOKEN_RE) ?? []) as string[];
  const compact = normalized.replace(/(?<=[a-z])\s+(?=\d)|(?<=\d)\s+(?=[a-z])/gu, "");
  const compactTokens = (compact.match(TOKEN_RE) ?? []).filter((token: string) => !raw.includes(token));
  const output: string[] = [];
  for (const token of [...raw, ...compactTokens]) {
    if (ASCII_RE.test(token)) output.push(token);
    else output.push(...segmentChinese(token));
  }
  return output;
}
