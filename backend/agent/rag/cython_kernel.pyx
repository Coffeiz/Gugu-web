# cython: boundscheck=False
# cython: wraparound=False
# cython: initializedcheck=False
# cython: cdivision=True

"""纯 BM25 倒排扫描内核；输入布局和查询词由 Python 适配层管理。"""

from array import array as make_array
from cpython cimport array as c_array
from libc.math cimport log, pow, sqrt


def _score_sort_key(item):
    return (-item[0], item[1])


cpdef list search_bm25(
    const int[::1] document_lengths,
    const int[::1] term_offsets,
    const int[::1] posting_document_ids,
    const int[::1] posting_frequencies,
    const int[::1] document_frequencies,
    const int[::1] document_tie_ranks,
    const int[::1] query_term_ids,
    const int[::1] eligible_document_mask,
    double average_length,
    int limit,
):
    cdef Py_ssize_t document_count = document_lengths.shape[0]
    cdef Py_ssize_t term_index, posting_index, document_id
    cdef int term_id, frequency, document_frequency, length, result_limit
    cdef double idf, norm, score
    cdef c_array.array score_storage = make_array('d', [0.0]) * document_count
    cdef double[::1] scores = score_storage
    cdef list scored_items = []
    cdef list touched_documents = []

    if document_count == 0 or limit <= 0:
        return []
    if term_offsets.shape[0] != document_frequencies.shape[0] + 1:
        raise ValueError("BM25 CSR offsets 与 document frequency 长度不一致")
    if posting_document_ids.shape[0] != posting_frequencies.shape[0]:
        raise ValueError("BM25 posting 文档 ID 与词频长度不一致")
    if document_tie_ranks.shape[0] != document_count:
        raise ValueError("BM25 tie rank 数量与文档数量不一致")
    if eligible_document_mask.shape[0] != document_count:
        raise ValueError("BM25 eligibility mask 数量与文档数量不一致")

    result_limit = min(limit, document_count)

    for term_index in range(query_term_ids.shape[0]):
        term_id = query_term_ids[term_index]
        if term_id < 0:
            continue
        if term_id >= document_frequencies.shape[0]:
            raise ValueError("BM25 查询词项 ID 超出索引范围")
        document_frequency = document_frequencies[term_id]
        if document_frequency <= 0:
            continue
        idf = log(1.0 + (document_count - document_frequency + 0.5) / (document_frequency + 0.5))
        for posting_index in range(term_offsets[term_id], term_offsets[term_id + 1]):
            document_id = posting_document_ids[posting_index]
            frequency = posting_frequencies[posting_index]
            length = max(1, document_lengths[document_id])
            norm = frequency + 1.2 * (1.0 - 0.75 + 0.75 * length / max(1.0, average_length))
            if scores[document_id] == 0.0:
                touched_documents.append(document_id)
            scores[document_id] += idf * frequency * 2.2 / norm

    # 词项较稀疏时只遍历真实命中文档，避免对整个语料做第二次扫描。
    for document_id in touched_documents:
        if not eligible_document_mask[document_id]:
            continue
        score = scores[document_id]
        if score <= 0.0:
            continue
        scored_items.append((score, document_tie_ranks[document_id], document_id))

    # 全量预计算（unified_query 需先按来源/scope 过滤）不能用 O(N*K) 插入排序。
    # Python Timsort 对正命中集合做 O(N log N) 稳定排序，再截取调用方 Top-K。
    scored_items.sort(key=_score_sort_key)
    return [(item[2], item[0]) for item in scored_items[:result_limit]]


cpdef list cosine_scores(
    const double[::1] query,
    const double[::1] vector_values,
    const int[::1] vector_offsets,
    const int[::1] vector_lengths,
):
    """计算 TS hybridFuseScores 使用的向量余弦；空向量不进入向量排名。"""
    cdef Py_ssize_t vector_count = vector_lengths.shape[0]
    cdef Py_ssize_t vector_id, offset, index
    cdef int length
    cdef double dot, query_norm, vector_norm, value
    cdef list output = []

    if vector_offsets.shape[0] != vector_count + 1:
        raise ValueError("向量 offsets 与 lengths 长度不一致")
    if vector_offsets[vector_count] != vector_values.shape[0]:
        raise ValueError("向量 offsets 与 values 长度不一致")
    for vector_id in range(vector_count):
        length = vector_lengths[vector_id]
        if length < 0 or vector_offsets[vector_id + 1] - vector_offsets[vector_id] != length:
            raise ValueError("向量长度与 offsets 不一致")
        if length == 0:
            continue
        if length != query.shape[0]:
            output.append((vector_id, 0.0))
            continue
        offset = vector_offsets[vector_id]
        dot = 0.0
        query_norm = 0.0
        vector_norm = 0.0
        for index in range(length):
            value = vector_values[offset + index]
            dot += query[index] * value
            query_norm += query[index] * query[index]
            vector_norm += value * value
        if query_norm == 0.0 or vector_norm == 0.0:
            output.append((vector_id, 0.0))
        else:
            output.append((vector_id, dot / (sqrt(query_norm) * sqrt(vector_norm))))
    return output


cpdef tuple idf_rescore(
    const int[::1] document_frequencies,
    const int[::1] term_frequencies,
    int document_count,
    double average_length,
    int document_length,
    double k1=1.2,
    double b=0.75,
    double idf_exponent=1.0,
    double contribution_exponent=1.5,
    double minimum_query_weight=0.25,
    double maximum_query_weight=4.0,
):
    """计算 TS idf-rescore 的 IDF baseline 与逐词非线性 contribution。"""
    cdef Py_ssize_t term_index
    cdef int df, tf, effective_length
    cdef double term_idf, baseline = 0.0, query_weight, norm, bm25, weighted
    cdef double nonlinear
    cdef Py_ssize_t indexed_count = 0
    cdef list indexed_idfs = []
    cdef list contributions = []

    if document_frequencies.shape[0] != term_frequencies.shape[0]:
        raise ValueError("IDF rescore 词频与文档频率长度不一致")
    if document_count <= 0:
        return 0.0, [], []
    for term_index in range(document_frequencies.shape[0]):
        df = document_frequencies[term_index]
        if df < 0:
            continue
        if df > document_count:
            raise ValueError("IDF 文档频率大于语料文档数")
        term_idf = log(1.0 + (document_count - df + 0.5) / (df + 0.5))
        baseline += term_idf
        indexed_count += 1
        indexed_idfs.append((term_index, term_idf))
    if indexed_count == 0:
        return 0.0, [], []
    baseline /= indexed_count
    if baseline <= 0.0:
        return 0.0, indexed_idfs, []

    effective_length = max(1, document_length)
    for term_index in range(document_frequencies.shape[0]):
        df = document_frequencies[term_index]
        tf = term_frequencies[term_index]
        if df < 0 or tf <= 0:
            continue
        term_idf = log(1.0 + (document_count - df + 0.5) / (df + 0.5))
        query_weight = pow(term_idf / baseline, idf_exponent)
        query_weight = min(maximum_query_weight, max(minimum_query_weight, query_weight))
        norm = tf + k1 * (1.0 - b + b * effective_length / (average_length if average_length else 1.0))
        bm25 = term_idf * tf * (k1 + 1.0) / norm
        weighted = bm25 * query_weight
        nonlinear = pow(weighted, contribution_exponent)
        contributions.append((term_index, term_idf, query_weight, tf, weighted, nonlinear))
    return baseline, indexed_idfs, contributions
