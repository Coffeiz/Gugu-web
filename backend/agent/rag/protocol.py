"""RAG 与 TypeScript worker 之间的稳定协议和投影版本。"""

TOKENIZER_VERSION = "ts-jieba-words-v3"
# 与 tokenizer 独立：来源字段、摘要和 chunk 组织变化时必须使缓存失效。
# v4：revision 的 max(indexed_at) 口径改为含墓碑行（软删行参与 max），
# 作为 worker 增量同步的单游标水位；口径变化使既有索引状态一次性失效重载。
RAG_PROJECTION_VERSION = "rag-projection-v4"

__all__ = ["RAG_PROJECTION_VERSION", "TOKENIZER_VERSION"]
