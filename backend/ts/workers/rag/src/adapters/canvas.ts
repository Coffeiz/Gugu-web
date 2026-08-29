import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type CanvasSourceRecord = {
  canvas_id: string | number;
  node_id: string | number;
  canvas_title: string;
  node_title: string;
  node_type: string;
  content?: string;
  group_path?: string;
  relation_summary?: string;
  project_id?: string | number | null;
  document_version: string;
  updated_at?: string;
  scope: RagSearchScope;
};

export const canvasAdapter: SourceAdapter<CanvasSourceRecord> = {
  sourceType: "canvas",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (record.canvas_id === null || record.canvas_id === undefined || record.node_id === null || record.node_id === undefined || !validScope(record.scope)) return [];
      const text = [
        `画布：${record.canvas_title || "未命名画布"}`,
        `节点：${record.node_title || "未命名节点"}`,
        `类型：${record.node_type}`,
        record.group_path ? `分组：${record.group_path}` : "",
        record.relation_summary || "",
        record.content || "",
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: `${record.canvas_id}:${record.node_id}`,
        source_type: "canvas", scope: record.scope,
        title: `${record.canvas_title || "未命名画布"} · ${record.node_title || "未命名节点"}`,
        content: text, document_version: record.document_version,
        updated_at: record.updated_at,
        metadata: {
          canvas_id: String(record.canvas_id),
          node_id: String(record.node_id),
          node_type: record.node_type,
          group_path: record.group_path || "",
          project_id: record.project_id == null ? "" : String(record.project_id),
        },
      });
    });
  },
};
