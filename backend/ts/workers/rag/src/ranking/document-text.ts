import type { RagDocument } from "../../../../packages/contracts/src/rag.ts";

/**
 * 返回用于词法检索与重排的文本。
 *
 * 展示/引用仍使用 document.text；来源可以通过 ranking_text 明确声明
 * 不应参与排序的展示字段，例如 conversation 的自动生成会话标题。
 */
export function rankingText(document: Pick<RagDocument, "text" | "ranking_text">): string {
  return String(document.ranking_text ?? document.text ?? "");
}
