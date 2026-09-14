/** RAG 原文分词器：Jieba 词边界 + ASCII 实体。 */

import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";

const TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/gu;
const ASCII_RE = /^[\x00-\x7F]+$/u;
const jieba = Jieba.withDict(dict);

const CHINESE_MONTHS: ReadonlyArray<readonly [string, number]> = [
  ["十二", 12], ["十一", 11], ["十", 10], ["九", 9], ["八", 8], ["七", 7],
  ["六", 6], ["五", 5], ["四", 4], ["三", 3], ["二", 2], ["一", 1],
];

const ENGLISH_MONTHS: ReadonlyArray<readonly [string, number]> = [
  ["january", 1], ["jan", 1], ["february", 2], ["feb", 2],
  ["march", 3], ["mar", 3], ["april", 4], ["apr", 4],
  ["may", 5], ["june", 6], ["jun", 6], ["july", 7], ["jul", 7],
  ["august", 8], ["aug", 8], ["september", 9], ["sept", 9], ["sep", 9],
  ["october", 10], ["oct", 10], ["november", 11], ["nov", 11],
  ["december", 12], ["dec", 12],
];

function monthToken(month: number): string {
  return `month_${String(month).padStart(2, "0")}`;
}

/** 将明确的日期/月名映射为规范月份词项；不从月份猜测年份。 */
function dateMonthTokens(text: string): string[] {
  const normalized = text.toLocaleLowerCase();
  const months = new Set<number>();

  for (const match of normalized.matchAll(/\b\d{4}[-/.](0?[1-9]|1[0-2])(?=[-/.]\d{1,2}\b|\b)/gu)) {
    months.add(Number(match[1]));
  }
  for (const match of normalized.matchAll(/(?<!\d)(0?[1-9]|1[0-2])\s*月(?:份)?/gu)) {
    months.add(Number(match[1]));
  }

  const chineseMonthPattern = new RegExp(`(${CHINESE_MONTHS.map(([name]) => name).join("|")})月(?:份)?`, "gu");
  for (const match of normalized.matchAll(chineseMonthPattern)) {
    const month = CHINESE_MONTHS.find(([name]) => name === match[1])?.[1];
    if (month) months.add(month);
  }

  const englishMonthPattern = new RegExp(`\\b(${ENGLISH_MONTHS.map(([name]) => name).join("|")})\\b`, "gu");
  for (const match of normalized.matchAll(englishMonthPattern)) {
    const month = ENGLISH_MONTHS.find(([name]) => name === match[1])?.[1];
    if (!month) continue;

    // March / May 在英语里常作普通词；仅在日期或明确时间介词语境中识别为月份。
    if (month === 3 || month === 5) {
      const before = normalized.slice(Math.max(0, match.index - 24), match.index);
      const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 24);
      const hasDateContext = /(?:\d{1,4}|\b(?:in|during|since|until|by|from|throughout))\s*$/u.test(before)
        || /^\s*,?\s*\d{1,4}\b/u.test(after);
      if (!hasDateContext) continue;
    }
    months.add(month);
  }

  return [...months].map(monthToken);
}

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
  for (const alias of dateMonthTokens(normalized)) {
    if (!output.includes(alias)) output.push(alias);
  }
  return output;
}
