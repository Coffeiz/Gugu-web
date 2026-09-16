# sudachidict core → small 档罗马音质量报告

- 日期：2026-09-16　语料：204 条（8 类）　对比维度：罗马音结果、分词数、UNK 代理

## 结论

- 罗马音一致率：**198/204（97.1%）**
- 分词数一致率：184/204（90.2%）
- UNK 代理 token：core 1 个 vs small 1 个
- 词典体积：core 217MB → small 123MB
- tokenize 耗时（30 轮均值/52 条）：core 0.1ms vs small 0.1ms

## 分类明细

| 分类 | 条数 | 罗马音一致 | 分词一致 |
|---|---|---|---|
| 常用词汇 | 40 | 40（100%） | 38（95%） |
| 片假名外来语 | 30 | 30（100%） | 29（97%） |
| 人名地名 | 35 | 34（97%） | 30（86%） |
| 生僻文语 | 40 | 39（98%） | 33（82%） |
| 日常句子 | 12 | 11（92%） | 10（83%） |
| 数字与日期 | 15 | 15（100%） | 13（87%） |
| 促音拗音长音 | 20 | 19（95%） | 19（95%） |
| 英数混排 | 12 | 10（83%） | 12（100%） |

## 不一致明细

- `石垣島`：core=`ishigakijima` small=`ishigakitou`（人名地名）
- `雪月花`：core=`setsugekka` small=`yukigekka`（生僻文语）
- `日本語を勉強しています`：core=`nihongowobenkyoushiteimasu` small=`nippongowobenkyoushiteimasu`（日常句子）
- `お母さん`：core=`okaasan` small=`ohahasan`（促音拗音长音）
- `iOSアプリ`：core=`aio-esuapuri` small=`iosapuri`（英数混排）
- `macOS対応`：core=`makkuo-esutaiou` small=`macostaiou`（英数混排）

## 影响分析

- **无存量数据错位**：罗马音转换发生在查询时（search.py 的 `_romaji_matches_object` 对原文现转），文本与查询两侧用同一词典，切档后自洽；没有任何罗马音落库。
- 差异分三类：① core 正确、small 退化的熟语/复合读音（如 雪月花→setsugekka vs yukigekka）；② 两读皆合法（日本語：にほんご/にっぽんご）；③ small 反而更好（iOS/macOS 拉丁缩写 small 原样保留，用户按 "ios"/"macos" 搜索能命中）。
- 搜索回归面：仅当用户恰好使用 core 档读音去搜「被 small 转不同」的词时 miss（如搜 okaasan，small 将 お母さん 转为 ohahasan）；此类词为少数派，且随词典自洽，同音重查无影响。

## 复现

```bash
backend/.venv/bin/python report/romaji_dict_compare.py --output report
```

需同时安装 sudachidict_core 与 sudachidict_small。
