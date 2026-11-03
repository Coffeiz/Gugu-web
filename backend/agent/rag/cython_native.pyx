# cython: language_level=3
# cython: boundscheck=False
# cython: wraparound=False
# cython: initializedcheck=False

"""RAG 冷建与快照路径的批量 Cython 数据处理内核。"""

from array import array
from cpython cimport array as c_array
import hashlib
import json
from libc.math cimport isfinite


cpdef list tokenize_raw(str text):
    """在 Cython 循环中执行与 Python 参考实现相同的 token 投影。"""
    from agent.rag import cython_tokenizer as reference

    cdef str normalized = (text or "").lower()
    cdef list raw = reference._TOKEN_RE.findall(normalized)
    cdef str compact = reference._COMPACT_RE.sub("", normalized)
    cdef set raw_set = set(raw)
    cdef list compact_tokens = []
    cdef list output = []
    cdef object token
    cdef object word
    cdef object month_alias

    for token in reference._TOKEN_RE.findall(compact):
        if token not in raw_set:
            compact_tokens.append(token)
    for token in raw:
        # _TOKEN_RE 只能生成 ASCII 字母数字下划线或汉字；isascii() 与 TS
        # 规则的 ASCII 判断等价，避免每个词项再调用一次 Python 正则。
        if token.isascii():
            output.append(token)
        else:
            for word in reference._segment_chinese(token):
                output.append(word)
    for token in compact_tokens:
        if token.isascii():
            output.append(token)
        else:
            for word in reference._segment_chinese(token):
                output.append(word)
    for month_alias in reference._month_aliases(normalized):
        if month_alias not in output:
            output.append(month_alias)
    return output


cpdef list tokenize_many(object texts):
    """批量投影文本，减少大语料逐文档穿越 Python API 的开销。"""
    cdef Py_ssize_t position
    cdef Py_ssize_t count = len(texts)
    cdef list output = []
    for position in range(count):
        output.append(tokenize_raw(str(texts[position] or "")))
    return output


cpdef list ranking_text_many(object documents, bint database_projection=False):
    """在编译循环中按 TS 兼容规则提取整批文档的词法文本。"""
    cdef list output = []
    cdef object document
    cdef object content
    cdef object summary
    cdef object metadata
    cdef object parts

    for document in documents:
        if database_projection:
            if document.source_type == "conversation":
                output.append(str(document.content))
            else:
                parts = [document.title]
                if document.summary:
                    parts.append(document.summary)
                parts.append(document.content)
                output.append("\n".join(parts))
            continue
        if document.source_type == "conversation":
            metadata = document.metadata
            output.append(str(metadata.get("context_current") or document.content))
            continue
        content = document.content
        summary = document.summary
        parts = [document.title]
        if summary and not str(content).strip().startswith(summary):
            parts.append(summary)
        parts.append(content)
        output.append("\n".join(parts))
    return output


cpdef str memory_revision(object documents, str vector_version):
    """紧凑投影 transient 文档后一次序列化，避免构造完整 TS wire 字典树。"""
    cdef object document
    cdef list rows = []
    cdef bytes encoded
    for document in documents:
        rows.append((
            document.document_id, document.source_type, document.source_id,
            (document.scope.owner_user_id, document.scope.platform,
             document.scope.bot_id, document.scope.group_id,
             document.scope.scope_type, document.scope.scope_id),
            document.title, document.summary, document.content, document.version,
            document.chunk_index, document.chunk_count,
            document.parent_document_id, document.updated_at, document.metadata,
        ))
    encoded = json.dumps(
        ("cython-memory-revision-v1", vector_version or "", rows),
        ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


cpdef tuple patch_csr(
    object old_lengths,
    object old_offsets,
    object old_posting_documents,
    object old_posting_frequencies,
    object old_term_ids,
    object reusable_positions,
    object next_keys,
    object changed_documents,
):
    """编译执行 BM25 delta 的 posting 复用、变化文档分词与 CSR 重组。"""
    from agent.rag.cython_collation import locale_sort_key

    cdef Py_ssize_t term_count = len(old_offsets) - 1
    cdef Py_ssize_t term_id
    cdef Py_ssize_t posting_index
    cdef Py_ssize_t old_position
    cdef Py_ssize_t new_position
    cdef Py_ssize_t position
    cdef Py_ssize_t rank
    cdef Py_ssize_t total_length = 0
    cdef object term
    cdef object mapped_position
    cdef object postings
    cdef object frequencies
    cdef object token
    cdef object changed_entry
    cdef object changed_terms
    cdef object frequency
    cdef object ranked_entry
    cdef dict reverse_terms = {}
    cdef dict grouped = {}
    cdef dict term_ids = {}
    cdef dict changed_frequency
    cdef list ranked_positions
    cdef c_array.array lengths = array("i", [0]) * len(next_keys)
    cdef c_array.array offsets = array("i", [0])
    cdef c_array.array posting_documents = array("i")
    cdef c_array.array posting_frequencies = array("i")
    cdef c_array.array document_frequencies = array("i")
    cdef c_array.array tie_ranks = array("i", [0]) * len(next_keys)

    for term, term_id in old_term_ids.items():
        reverse_terms[term_id] = term
    for term_id in range(term_count):
        term = reverse_terms[term_id]
        postings = array("i")
        frequencies = array("i")
        for posting_index in range(old_offsets[term_id], old_offsets[term_id + 1]):
            old_position = old_posting_documents[posting_index]
            mapped_position = reusable_positions.get(old_position)
            if mapped_position is None:
                continue
            postings.append(mapped_position)
            frequencies.append(old_posting_frequencies[posting_index])
        if postings:
            grouped[term] = (postings, frequencies)

    for old_position, new_position in reusable_positions.items():
        lengths[new_position] = old_lengths[old_position]

    for changed_entry in changed_documents:
        position = changed_entry[0]
        changed_terms = tokenize_raw(changed_entry[1])
        changed_frequency = {}
        for token in changed_terms:
            if token:
                changed_frequency[token] = changed_frequency.get(token, 0) + 1
        for term, frequency in changed_frequency.items():
            lengths[position] += frequency
            postings = grouped.get(term)
            if postings is None:
                postings = (array("i"), array("i"))
                grouped[term] = postings
            postings[0].append(position)
            postings[1].append(frequency)

    for term, (postings, frequencies) in grouped.items():
        if not postings:
            continue
        term_ids[term] = len(term_ids)
        posting_documents.extend(postings)
        posting_frequencies.extend(frequencies)
        document_frequencies.append(len(postings))
        offsets.append(len(posting_documents))

    ranked_positions = [
        (locale_sort_key(key), position) for position, key in enumerate(next_keys)
    ]
    ranked_positions.sort()
    for rank, ranked_entry in enumerate(ranked_positions):
        tie_ranks[ranked_entry[1]] = rank

    for position in range(len(lengths)):
        total_length += lengths[position]
    return (
        lengths, offsets, posting_documents, posting_frequencies,
        document_frequencies, tie_ranks, term_ids,
        total_length / len(lengths) if lengths else 0.0,
    )


cpdef tuple build_csr(object documents, Py_ssize_t document_count, object document_keys, bint tie_by_key):
    """把 canonical token stream 构造成 BM25 CSR 数组。"""
    from agent.rag.cython_collation import locale_sort_key

    cdef Py_ssize_t document_id
    cdef Py_ssize_t term_id
    cdef Py_ssize_t posting_index
    cdef Py_ssize_t rank
    cdef Py_ssize_t total_length = 0
    cdef object terms
    cdef object raw_term
    cdef object term
    cdef object frequencies
    cdef object frequency
    cdef object term_id_value
    cdef object term_document_ids
    cdef object term_frequencies
    cdef object document_iterator = iter(documents)
    cdef list ranked_ids
    cdef object ranked_entry
    cdef dict term_ids = {}
    cdef list posting_document_ids_by_term = []
    cdef list posting_frequencies_by_term = []
    cdef c_array.array lengths = array("i")
    cdef c_array.array offsets = array("i", [0])
    cdef c_array.array posting_document_ids = array("i")
    cdef c_array.array posting_frequencies = array("i")
    cdef c_array.array document_frequencies = array("i")
    cdef c_array.array tie_ranks
    cdef list keys = []
    cdef object raw_key

    for raw_key in document_keys:
        keys.append(str(raw_key))
    if len(set(keys)) != document_count:
        raise ValueError("BM25 document_keys 必须唯一")

    for document_id in range(document_count):
        try:
            terms = next(document_iterator)
        except StopIteration as error:
            raise ValueError("BM25 token stream 的文档数少于声明数量") from error
        frequencies = {}
        for raw_term in terms:
            if not raw_term:
                continue
            term = raw_term if isinstance(raw_term, str) else str(raw_term)
            frequencies[term] = frequencies.get(term, 0) + 1
        if sum(frequencies.values()) >= 2**31:
            raise ValueError("单文档词项数超过 Cython BM25 内核支持范围")
        lengths.append(sum(frequencies.values()))
        total_length += lengths[document_id]
        for term, frequency in frequencies.items():
            term_id_value = term_ids.get(term)
            if term_id_value is None:
                term_id = len(term_ids)
                term_ids[term] = term_id
                posting_document_ids_by_term.append(array("i"))
                posting_frequencies_by_term.append(array("i"))
            else:
                term_id = term_id_value
            posting_document_ids_by_term[term_id].append(document_id)
            posting_frequencies_by_term[term_id].append(frequency)
    try:
        next(document_iterator)
    except StopIteration:
        pass
    else:
        raise ValueError("BM25 token stream 的文档数超过声明数量")

    for term_id in range(len(posting_document_ids_by_term)):
        term_document_ids = posting_document_ids_by_term[term_id]
        term_frequencies = posting_frequencies_by_term[term_id]
        if len(term_document_ids) >= 2**31:
            raise ValueError("倒排表超过 Cython BM25 内核支持的 32 位索引范围")
        document_frequencies.append(len(term_document_ids))
        for posting_index in range(len(term_document_ids)):
            posting_document_ids.append(term_document_ids[posting_index])
            posting_frequencies.append(term_frequencies[posting_index])
        offsets.append(len(posting_document_ids))
        posting_document_ids_by_term[term_id] = None
        posting_frequencies_by_term[term_id] = None

    if tie_by_key:
        tie_ranks = array("i", [0]) * len(keys)
        ranked_ids = [(locale_sort_key(key), position) for position, key in enumerate(keys)]
        ranked_ids.sort()
        for rank, ranked_entry in enumerate(ranked_ids):
            tie_ranks[ranked_entry[1]] = rank
    else:
        tie_ranks = array("i", range(len(keys)))

    return (
        lengths, offsets, posting_document_ids, posting_frequencies,
        document_frequencies, tie_ranks, term_ids,
        total_length / len(lengths) if lengths else 0.0,
    )


cpdef dict validate_vector_mapping(object parsed, str vector_version):
    """校验已解析 JSON 并将有效向量映射成稳定的 Python float 列表。"""
    cdef dict output = {}
    cdef object key
    cdef object item
    cdef object raw_vector
    cdef object raw_value
    cdef list vector
    cdef double number

    if not isinstance(parsed, dict):
        return output
    for key, item in parsed.items():
        if not isinstance(item, dict) or item.get("t") != vector_version:
            continue
        raw_vector = item.get("v")
        if not isinstance(raw_vector, list):
            continue
        vector = []
        for raw_value in raw_vector:
            if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
                vector = []
                break
            number = float(raw_value)
            if not isfinite(number):
                vector = []
                break
            vector.append(number)
        else:
            output[str(key)] = vector
    return output


cpdef dict map_document_vectors(object documents, object vector_maps, object cache_key_fn):
    """按文档来源映射向量，避免 Python 层逐文档构建中间字典。"""
    cdef dict result = {}
    cdef object document
    cdef object cache_name
    cdef object key
    cdef object vector
    cdef object metadata

    for document in documents:
        if document.source_id == "pattern":
            cache_name = "pattern"
            metadata = document.metadata
            key = str(metadata.get("vector_key") or "")
        elif document.source_type == "knowledge":
            cache_name = "knowledge"
            key = cache_key_fn(document) or ""
        else:
            cache_name = "memory"
            key = cache_key_fn(document) or ""
        vector = vector_maps[cache_name].get(key)
        if vector is not None:
            result[document.chunk_id] = vector
    return result


cpdef tuple tokens_by_document(
    object document_lengths,
    object term_offsets,
    object posting_document_ids,
    object posting_frequencies,
    object term_ids,
):
    """从 CSR 还原快照 token 多重集，减少 Python 层倒排遍历开销。"""
    cdef Py_ssize_t document_count = len(document_lengths)
    cdef Py_ssize_t term_count = len(term_offsets) - 1
    cdef Py_ssize_t term_id
    cdef Py_ssize_t posting_index
    cdef Py_ssize_t position
    cdef int frequency
    cdef list terms_by_id = [""] * term_count
    cdef list result = []
    cdef list frozen_result = []
    cdef object term
    cdef object terms

    for _ in range(document_count):
        result.append([])

    for term, term_id in term_ids.items():
        terms_by_id[term_id] = term
    for term_id in range(term_count):
        for posting_index in range(term_offsets[term_id], term_offsets[term_id + 1]):
            position = posting_document_ids[posting_index]
            frequency = posting_frequencies[posting_index]
            for _ in range(frequency):
                result[position].append(terms_by_id[term_id])
    for position in range(document_count):
        if len(result[position]) != document_lengths[position]:
            raise RuntimeError("BM25 CSR token 多重集与文档长度不一致")
        frozen_result.append(tuple(result[position]))
    return tuple(frozen_result)


cpdef list snapshot_document_records(object documents):
    """将索引文档投影为快照 wire records，避免逐文档 Python helper 调用。"""
    cdef list records = []
    cdef object document
    cdef object scope
    cdef object metadata

    for document in documents:
        scope = document.scope
        metadata = document.metadata
        records.append({
            "document_id": document.document_id,
            "source_type": document.source_type,
            "source_id": document.source_id,
            "scope": {
                "owner_user_id": scope.owner_user_id,
                "platform": scope.platform,
                "bot_id": scope.bot_id,
                "group_id": scope.group_id,
                "scope_type": scope.scope_type,
                "scope_id": scope.scope_id,
            },
            "title": document.title,
            "summary": document.summary,
            "content": document.content,
            "version": document.version,
            "chunk_index": document.chunk_index,
            "chunk_count": document.chunk_count,
            "parent_document_id": document.parent_document_id,
            "updated_at": document.updated_at,
            "metadata": metadata,
        })
    return records


cpdef tuple snapshot_rows_to_documents(object rows):
    """将已投影的 SQL 行转成文档与水位元数据；不执行 SQL/网络 I/O。"""
    from agent.rag.persistent_store import _js_iso_datetime

    cdef list documents = []
    cdef dict revision_by_source = {}
    cdef object row
    cdef object source
    cdef object source_revision
    cdef object max_indexed_at = None

    for row in rows:
        source = str(row.source_type or "")
        source_revision = row.source_max_indexed_at
        if source:
            revision_by_source[source] = _js_iso_datetime(source_revision)
        if source_revision is not None and (
            max_indexed_at is None or source_revision > max_indexed_at
        ):
            max_indexed_at = source_revision
        if row.id is None or row.deleted_at is not None:
            continue
        documents.append(database_row_to_document(row))
    return documents, revision_by_source, max_indexed_at


cpdef object database_row_to_document(object row):
    """把已取得的 SQL 行转换为公开 RAG 文档对象。"""
    from agent.rag.models import IndexDocument, Scope

    cdef object updated_at = row.source_updated_at.isoformat() if row.source_updated_at else None
    return IndexDocument(
        document_id=row.document_id,
        source_type=row.source_type,
        source_id=row.source_id,
        scope=Scope(
            owner_user_id=str(row.owner_user_id),
            platform=row.platform or "",
            bot_id=row.bot_id or "",
            group_id=row.group_id or "",
            scope_type=row.scope_type or "owner",
            scope_id=row.scope_id or "",
        ),
        title=row.title or "",
        summary=row.summary or "",
        content=row.content or "",
        version=row.document_version,
        chunk_index=row.chunk_index,
        chunk_count=row.chunk_count,
        parent_document_id=row.parent_document_id,
        updated_at=updated_at,
        metadata=row.metadata_json if isinstance(row.metadata_json, dict) else {},
    )


cpdef tuple delta_rows_to_changes(object rows, object cursor):
    """將一頁增量 SQL 行拆成 live upsert、墓碑 slot 與最新游标。"""
    from agent.rag.delta import chunk_slot_key
    from agent.rag.persistent_store import RagIndexCursor

    cdef list upserts = []
    cdef list deletes = []
    cdef object next_cursor = cursor
    cdef object row
    cdef object document
    cdef object parent

    for row in rows:
        if row.indexed_at is not None:
            next_cursor = RagIndexCursor(row.indexed_at, int(row.id or 0))
        document = database_row_to_document(row)
        if row.deleted_at is not None:
            parent = str(row.parent_document_id or row.document_id or "")
            if parent:
                deletes.append(chunk_slot_key(document))
        else:
            upserts.append(document)
    return upserts, deletes, next_cursor


cpdef dict snapshot_payload(
    str version,
    str owner_id,
    str revision,
    object watermark,
    object documents,
    object lexical_index,
    object vectors,
    str vector_version,
):
    """在编译循环中复制快照对象；磁盘事务仍由 Python 生命周期层负责。"""
    cdef dict payload = {}
    cdef dict vector_copy = {}
    cdef object key
    cdef object vector

    payload["version"] = version
    payload["owner_id"] = owner_id
    payload["revision"] = revision
    if watermark:
        payload["watermark"] = {
            "ts": watermark.timestamp.isoformat(), "id": watermark.row_id,
        }
    else:
        payload["watermark"] = None
    payload["documents"] = snapshot_document_records(documents)
    payload["tokens"] = tokens_by_document(
        lexical_index.bm25.document_lengths,
        lexical_index.bm25.term_offsets,
        lexical_index.bm25.posting_document_ids,
        lexical_index.bm25.posting_frequencies,
        lexical_index.bm25.term_ids,
    )
    for key, vector in vectors.items():
        vector_copy[key] = list(vector)
    payload["vectors"] = vector_copy
    payload["vector_version"] = vector_version
    return payload


cpdef void dump_snapshot(object stream, object payload):
    """统一快照 JSON 选项；Cython 侧完成快照写出调用，不改变 JSON 契约。"""
    json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
