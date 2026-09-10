"""RAG 与 TypeScript worker 之间的稳定协议和投影版本。"""

TOKENIZER_VERSION = "ts-jieba-words-v3"
# 与 tokenizer 独立：来源字段、摘要和 chunk 组织变化时必须使缓存失效。
RAG_PROJECTION_VERSION = "rag-projection-v3"

__all__ = ["RAG_PROJECTION_VERSION", "TOKENIZER_VERSION"]
