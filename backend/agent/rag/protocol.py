"""RAG 与 TypeScript worker 之间的稳定协议和投影版本。"""

TOKENIZER_VERSION = "ts-jieba-words-v4"
# 与 tokenizer 独立：来源字段、摘要和 chunk 组织变化时必须使缓存失效。
# v5：文件库退出统一 RAG，worker 重建时不再恢复或同步文件索引；此前 v4
# 已将墓碑行纳入 revision 水位，保持该语义不变。
RAG_PROJECTION_VERSION = "rag-projection-v5"

__all__ = ["RAG_PROJECTION_VERSION", "TOKENIZER_VERSION"]
