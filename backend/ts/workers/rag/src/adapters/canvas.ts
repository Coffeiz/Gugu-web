import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type CanvasSourceRecord = {
  /** MindCanvasItem 主键，作为稳定 source_id（不是 canvas_id:node_id）。 */
  id: string | number;
  canvas_id: string | number;
  canvas_title?: string;
  node_id: string | number;
  node_title?: string;
  node_type: string;
  /** 节点正文：content_plain 优先，其次 content_md，由收集器决定。 */
  content?: string;
  group_path?: string;
  /** 由收集器预汇总的双向关系摘要（最多 8 条，「；」分隔）。 */
  relation_summary?: string;
  project_id?: string | number | null;
  document_version?: string;
  /** 稳定版本输入：(id, item 更新时间 isoformat, node 业务版本)。 */
  version_parts?: (string | number)[];
  updated_at?: string;
  scope: RagSearchScope;
};

/** 画布适配器：画布/节点/类型/分组/关系五行头部 + 节点正文。 */
export const canvasAdapter: SourceAdapter<CanvasSourceRecord> = {
  sourceType: "canvas",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (
        record.id === null || record.id === undefined ||
        record.canvas_id === null || record.canvas_id === undefined ||
        record.node_id === null || record.node_id === undefined ||
        !validScope(record.scope)
      ) return [];
      const text = [
        `画布：${record.canvas_title || "未命名画布"}`,
        `节点：${record.node_title || "未命名节点"}`,
        `类型：${record.node_type}`,
        record.group_path ? `分组：${record.group_path}` : "",
        record.relation_summary ? `关系：${record.relation_summary}` : "",
        record.content || "",
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id), source_type: "canvas", scope: record.scope,
        title: `${record.canvas_title || "未命名画布"} · ${record.node_title || "未命名节点"}`,
        content: text, document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        updated_at: record.updated_at,
        metadata: {
          canvas_id: String(record.canvas_id),
          node_id: String(record.node_id),
          node_type: record.node_type,
          group_path: record.group_path || "",
          project_id: record.project_id == null ? "" : String(record.project_id),
          relation_summary: record.relation_summary || "",
        },
      });
    });
  },
};
