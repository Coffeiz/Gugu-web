# 基于词关联图的 RAG 词级语义扩展构思

## 1. 背景

现有 RAG 的词法检索通常依赖 BM25、TF-IDF、倒排索引等方法。

这类方法擅长判断：

* 一个词在当前文档中是否重要；
* 一个词在整个语料库中是否稀有；
* query 中的词是否直接出现在某条文档中。

例如：

```text
记忆：
黄山是一个旅游景点

query：
有什么旅游景点？
```

普通 BM25 可以因为 `旅游`、`景点` 的直接命中召回这条记忆。

但这里还存在一个更进一步的问题：

> 能不能不仅记录“某个词出现在哪里”，还记录“某个词经常和哪些高信息量词一起出现”？

例如从：

```text
黄山 是 一个 旅游 景点
```

得到：

```text
黄山 ↔ 旅游
黄山 ↔ 景点
旅游 ↔ 景点
```

最终形成一种：

```text
黄山:
  景点
  旅游
  安徽
  风景
  爬山
```

这样的词级关联索引。

这样，当用户查询：

```text
有什么旅游景点？
```

系统除了直接搜索 `旅游` 和 `景点`，还可以通过词关系图推导出：

```text
旅游 / 景点
    ↓
黄山
九寨沟
故宫
景区
风景区
```

再使用这些关联词辅助召回。

这相当于在传统倒排索引与向量语义检索之间增加一层：

> 可解释的词级语义关联层。

---

## 2. 核心直觉

传统 IDF 衡量：

> 一个词在整个语料库里有多稀有。

例如：

```text
idf("黄山") > idf("旅游")
```

因为 `黄山` 往往比 `旅游` 更少出现。

但单纯的 IDF 不会表达：

```text
黄山 ↔ 旅游景点
```

之间的关系。

因此可以进一步统计：

> 一个词附近经常出现哪些词，以及这些共现关系是否具有高区分度。

例如：

```text
黄山附近高频出现：
景点
旅游
安徽
风景
```

那么可以为 `黄山` 建立一个局部语义画像。

传统倒排索引：

```text
旅游 → doc1, doc8, doc31
景点 → doc1, doc9
```

词关联索引：

```text
旅游 →
  景点 0.92
  黄山 0.81
  九寨沟 0.64

景点 →
  旅游 0.92
  黄山 0.87
  故宫 0.76
```

这类结构可以理解为：

```text
Term Association Index
```

或者：

```text
Lexical Semantic Graph
```

---

## 3. 最简单的算法形式

对整个 corpus 分词后，使用滑动窗口统计词共现。

例如：

```text
黄山 是 中国 著名 的 旅游 景点
```

窗口大小为 3 时，可以产生：

```text
黄山 ↔ 中国
黄山 ↔ 著名
中国 ↔ 著名
中国 ↔ 旅游
著名 ↔ 旅游
著名 ↔ 景点
旅游 ↔ 景点
```

然后为每一对词累计：

```text
pair_count(a, b)
```

同时记录：

```text
term_count(a)
term_count(b)
```

最终生成：

```text
term → related terms
```

的数据结构。

例如：

```text
黄山:
  景点 0.84
  旅游 0.73
  安徽 0.52
```

---

## 4. 为什么不能只用“共现次数”

单纯使用：

```text
cooccur(a, b)
```

会有很大问题。

例如：

```text
是
一个
可以
这个
```

这些常见词可能和很多词共同出现。

因此需要结合“稀有度”和“关系异常程度”。

一个初步版本可以写成：

```text
association(a,b)
=
cooccur(a,b)
× idf(a)
× idf(b)
× distance_decay
```

其中：

```text
distance = 1 → 1.0
distance = 2 → 0.7
distance = 3 → 0.5
```

这样：

* 距离越近，关系越强；
* 高频无信息词因为 IDF 很低，会自然衰减；
* 稀有实体和重要概念的关系会更突出。

不过这仍然比较粗糙。

---

## 5. 更合理的方法：PMI / NPMI / PPMI

现有 NLP 中已经有与这个思路非常接近的经典算法：

```text
PMI(a,b)
=
log
P(a,b)
───────
P(a)P(b)
```

它衡量：

> 两个词共同出现的概率，相比“假设两者独立出现”高了多少。

例如：

```text
黄山
景点
```

如果：

```text
黄山出现 20 次
景点出现 1000 次
黄山与景点一起出现 15 次
```

那么：

```text
黄山 ↔ 景点
```

会得到很高的关联分。

PMI 本质上已经同时考虑：

```text
词 A 有多常见
词 B 有多常见
A/B 一起出现有多常见
```

所以它比：

```text
cooccur × idf
```

更加自然。

### PPMI

PMI 可能产生负数，因此通常使用：

```text
PPMI(a,b) = max(PMI(a,b), 0)
```

这样可以直接形成一个稀疏矩阵：

```text
             旅游   景点   安徽   苹果
黄山         .72    .91   .58    0
故宫         .61    .80   .10    0
iPhone        0      0     0    .83
```

query：

```text
旅游 景点
```

可以直接查：

```text
neighbors(旅游)
+
neighbors(景点)
```

得到：

```text
黄山     1.63
故宫     1.41
九寨沟   1.29
```

这与最初设想基本一致。

---

## 6. 可以加入距离衰减

传统 PMI 一般只判断“是否在某个窗口内共现”。

可以进一步加入：

```text
distance_decay
```

例如：

```text
距离 1：1.00
距离 2：0.75
距离 3：0.55
距离 4：0.40
```

则：

```text
weighted_cooccur(a,b)
=
Σ distance_decay(distance)
```

这样：

```text
黄山旅游景点
```

中的：

```text
旅游 ↔ 景点
```

会比：

```text
黄山 ↔ 景点
```

稍强。

最终：

```text
association
=
NPMI
× distance_decay
```

或者：

```text
association
=
PPMI
× distance_weight
```

---

## 7. 和 TextRank 的关系

TextRank4ZH 的做法是：

```text
文本
↓
分词
↓
局部共现
↓
构图
↓
PageRank
↓
关键词
```

节点：

```text
word
```

边：

```text
局部共现
```

它主要解决：

> 一篇文档里面，哪些词最重要？

本构思解决的是：

> 在整个知识库里，一个词通常与哪些词存在有意义的关联？

因此两者关系是：

```text
TextRank:
document-local graph
→ term importance

Term Association Index:
corpus-level graph
→ term relation
```

二者可以组合，但目标不同。

---

## 8. 和分布式语义的关系

这个想法实际上与传统 Distributional Semantics 非常接近。

经典思想：

> You shall know a word by the company it keeps.

即：

> 一个词的语义，可以由它经常和哪些词一起出现来描述。

因此：

```text
词 → 共现向量
```

本质上已经是一种稀疏语义表示。

例如：

```text
黄山 =
[
  景点: 0.91,
  旅游: 0.72,
  安徽: 0.58,
  风景: 0.51
]
```

而 Word2Vec 等方法某种程度上是在把这种：

```text
巨大稀疏共现空间
```

压缩成：

```text
低维 dense vector
```

因此本方案可以看成：

> 一个高度可解释、无需模型训练的 lexical embedding。

---

## 9. 和 Embedding 的区别

Embedding：

```text
旅游景点
↓
vector
↓ cosine
黄山
```

优点：

* 能捕捉同义表达；
* 对语言变化鲁棒；
* 有更强语义泛化能力。

缺点：

* 不容易解释；
* 需要 embedding provider；
* 更新成本高于纯统计索引；
* 相似度高不代表一定是正确关系。

Term Association：

```text
旅游
景点
↓
co-occurrence graph
↓
黄山
```

优点：

* 完全可解释；
* 可以增量更新；
* 不需要模型；
* 计算成本低；
* 对实体和具体词关系非常直观。

例如可以直接输出：

```text
召回“黄山”的原因：

旅游 → 黄山 0.73
景点 → 黄山 0.86
```

而 embedding 通常只能告诉：

```text
cosine_similarity = 0.78
```

---

## 10. 和现有算法/系统的对应关系

### PMI / NPMI / PPMI

与构思最接近。

用途：

```text
term → term association
```

可以直接作为第一版 baseline。

---

### Elasticsearch Significant Terms

它判断：

> 某个词在当前子语料中，是否比整个语料异常常见。

例如：

```text
foreground:
包含“旅游景点”的文档

background:
全部文档
```

然后发现：

```text
黄山
九寨沟
故宫
门票
景区
```

这个思想与：

```text
给一个概念寻找高关联词
```

非常接近。

---

### RM3

Pseudo Relevance Feedback。

流程：

```text
query
↓
BM25
↓
Top-K docs
↓
从 Top-K 中寻找重要词
↓
扩展 query
↓
重新检索
```

例如：

```text
旅游景点
```

第一次找到：

```text
黄山
九寨沟
故宫
```

然后第二次 query 变成：

```text
旅游^1.0
景点^1.0
黄山^0.3
九寨沟^0.25
故宫^0.2
```

RM3 是动态 query expansion。

本方案更偏：

```text
提前建立 corpus-level association index
```

---

### Rocchio

也是 query expansion 的经典方法。

本质：

```text
Q_new
=
原 query
+
相关文档特征
-
不相关文档特征
```

思想上也是：

> 用户输入的 query 不应该是最终 query。

---

## 11. 放入 RAG 的方式

一种结构：

```text
                 Query
                   │
        ┌──────────┼──────────┐
        ↓          ↓          ↓
      BM25       Vector    Term Graph
        │          │          │
        └──────────┼──────────┘
                   ↓
                  RRF
                   ↓
            field-aware rerank
```

Term Graph 可以成为一个独立 retriever。

但更简单的实现是：

```text
query
↓
tokenizer
↓
Term Association Expansion
↓
weighted query
↓
BM25
```

例如：

```text
原始 query:

旅游^1.0
景点^1.0
```

扩展后：

```text
旅游^1.0
景点^1.0
黄山^0.25
九寨沟^0.19
景区^0.17
```

再进入 BM25。

这样无需改变整个检索框架。

---

## 12. 一个可能的数据结构

可以实现：

```text
TermAssociationIndex
```

例如：

```json
{
  "旅游": [
    {"term": "景点", "score": 0.91},
    {"term": "黄山", "score": 0.78},
    {"term": "九寨沟", "score": 0.64}
  ],
  "景点": [
    {"term": "旅游", "score": 0.91},
    {"term": "黄山", "score": 0.84},
    {"term": "故宫", "score": 0.71}
  ]
}
```

实际只保留：

```text
Top-K neighbors
```

例如：

```text
K = 16 / 32 / 64
```

避免完整：

```text
term × term
```

矩阵过大。

---

## 13. 构建流程

```text
Corpus
↓
Tokenizer
↓
逐文档滑动窗口
↓
统计 term_count
↓
统计 pair_count
↓
计算 PMI / NPMI / PPMI
↓
加入 distance decay
↓
过滤低频关系
↓
每个 term 保留 Top-K neighbors
↓
TermAssociationIndex
```

---

## 14. Query 流程

```text
query
↓
tokenize
↓
原始 query tokens
↓
查 TermAssociationIndex
↓
合并多个 token 的 neighbor
↓
score aggregation
↓
衰减
↓
query expansion
↓
BM25 / hybrid retrieval
```

例如：

```text
query:
旅游 景点
```

查询：

```text
旅游 →
  黄山 0.73
  九寨沟 0.60

景点 →
  黄山 0.86
  故宫 0.68
```

聚合：

```text
黄山 = 0.73 + 0.86 = 1.59
九寨沟 = 0.60
故宫 = 0.68
```

归一化并衰减：

```text
旅游^1.0
景点^1.0
黄山^0.30
故宫^0.13
九寨沟^0.11
```

---

## 15. 防止 Query Drift

Query expansion 最大的问题是：

> 扩展词越来越偏离用户原意。

例如：

```text
苹果
```

可能同时关联：

```text
水果
iPhone
Apple
手机
营养
```

因此扩展词必须降低权重。

例如：

```text
original token weight = 1.0
1-hop expansion       <= 0.3
2-hop expansion       <= 0.08
```

第一版甚至可以只允许：

```text
1-hop
```

不做多跳。

并加入：

```text
minimum association threshold
minimum pair frequency
maximum expansion count
```

---

## 16. 与现有 RAG 排序结合

如果已有：

```text
rank_score
=
fused_score × field_factor
```

Term Association 最简单的作用不是修改最终排名，而是扩大 lexical recall。

即：

```text
TermAssociation
↓
Query Expansion
↓
BM25 recall
↓
Vector recall
↓
RRF
↓
Field-aware rerank
```

这样可以保持职责清晰：

```text
Term Graph:
解决“还能搜什么”

Field-aware rerank:
解决“哪个结果更重要”
```

---

## 17. 另一种用法：Document-side Importance

TextRank 也提供了另一个方向：

```text
IDF
→ corpus importance

TextRank
→ document-local importance

Title / Keywords
→ author-declared importance
```

可以组合成：

```text
term_importance
=
f(
  idf,
  local_centrality,
  field_position
)
```

例如某个 query token：

```text
IDF 高
+
TextRank 高
+
Title 命中
```

则可以判断：

> 这个词不仅稀有，而且是该文档核心概念。

以后可以考虑：

```text
rank_score
=
fused_score
× field_factor
× term_importance_factor
```

不过这一部分和 Term Association 是两个独立方向，可以分阶段实现。

---

## 18. 推荐第一版实验

暂时不引入复杂图算法。

先做一个最小 baseline：

```text
Tokenizer
+
Windowed Co-occurrence
+
NPMI
+
Distance Decay
+
Top-K Neighbors
```

参数：

```text
window = 5
min_pair_count = 2~3
neighbors_per_term = 16
expansion_limit = 8
expansion_weight <= 0.3
```

暂时：

```text
不做 PageRank
不做 multi-hop
不做 LLM
不做 embedding
```

测试它能否解决类似：

```text
黄山是一个旅游景点
```

随后查询：

```text
有哪些旅游景点？
```

以及：

```text
我以前提过哪些适合旅游的地方？
```

观察：

```text
Recall@K
Precision@K
query drift
```

的变化。

---

## 19. 最终定位

这个模块可以定位为：

```text
Corpus-level Lexical Semantic Graph
```

它不是替代：

```text
BM25
```

也不是替代：

```text
Embedding
```

而是在两者中间增加：

> 基于真实语料共现关系建立的、可解释的词级语义层。

最终形成：

```text
Exact lexical match
        │
       BM25
        │
        ▼
Term association graph
        │
        ▼
Vector semantics
```

三层语义能力：

```text
BM25
→ “用户说了什么”

Term Graph
→ “这些词通常和什么有关”

Embedding
→ “这些表达在语义上像什么”
```

三者负责不同层级的问题。

这个方向最大的价值并不是算法有多复杂，而是它可以让 RAG：

> 从“索引文本中写了什么”，进一步变成“索引知识中的概念关系”。
