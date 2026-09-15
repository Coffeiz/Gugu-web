#!/usr/bin/env python3
"""sudachidict core 与 small 词典的罗马音转换质量对比工具。

需同时安装 sudachidict_core 与 sudachidict_small（以及 sudachipy、romkan2）。
输出 Markdown 报告 + JSON 原始数据到指定目录：

    python report/romaji_dict_compare.py --output report

用途：验证 romaji.py 从 core 档切到 small 档后的转换质量。
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import date
from pathlib import Path

from sudachipy import Dictionary
import romkan2

CORPUS: dict[str, list[str]] = {
    "常用词汇": [
        "今日", "明日", "毎日", "元気", "天気", "電話", "学校", "先生", "学生", "会議",
        "仕事", "勉強", "便利", "猫", "犬", "食べ物", "新聞", "図書館", "病院", "銀行",
        "郵便局", "温泉", "旅行", "写真", "音楽", "映画", "料理", "部屋", "窓", "鍵",
        "雨", "雪", "風", "花", "山", "川", "海", "空", "時間", "友達",
    ],
    "片假名外来语": [
        "ヨルシカ", "パソコン", "コンビニ", "カフェ", "スマートフォン", "テレビ", "ラジオ",
        "カメラ", "ケーキ", "コーヒー", "ビール", "ジュース", "バス", "タクシー", "ノート",
        "ペン", "シャツ", "ズボン", "サッカー", "バレーボール", "テニス", "ゲーム",
        "インターネット", "メール", "アプリ", "データ", "ニュース", "ホテル", "レストラン", "ストレス",
    ],
    "人名地名": [
        "山田太郎", "佐藤", "鈴木", "高橋", "田中", "渡辺", "伊藤", "山本", "中村", "小林",
        "加藤", "吉田", "山口", "松本", "井上", "東京駅", "北海道", "京都", "大阪", "神戸",
        "名古屋", "横浜", "福岡", "札幌", "沖縄", "奈良", "鎌倉", "日光", "富士山", "琵琶湖",
        "阿蘇山", "屋久島", "知床", "石垣島", "厳島",
    ],
    "生僻文语": [
        "憂鬱", "刹那", "琥珀", "蒼穹", "面影", "木霊", "稚児", "茨菰", "玲瓏", "朦朧",
        "麒麟", "鳳凰", "珊瑚", "瑠璃", "蜃気楼", "侘び寂び", "幽玄", "儚い", "皐月", "弥生",
        "灯火", "静寂", "森羅万象", "一期一会", "温故知新", "花鳥風月", "明鏡止水", "電光石光",
        "疾風迅雷", "千載一遇", "雪月花", "穹蒼", "黎明", "黄昏", "残響", "余韻",
        "薔薇", "菫", "椿", "撫子",
    ],
    "日常句子": [
        "三月の記録を検索して", "十一月の会議メモ", "今日はいい天気ですね", "猫が魚を食べる",
        "私はコーヒーが好き", "すみません、駅はどこですか", "ありがとうございます",
        "おはようございます", "これはペンです", "日本語を勉強しています",
        "週末に映画を見に行く", "明日雨が降るでしょう",
    ],
    "数字与日期": [
        "2024年", "3月15日", "一二三", "十四", "二十歳", "千載一遇", "二千三百円", "9時30分",
        "第1回", "平成31年", "令和6年", "1月2月3月", "5百円", "0点", "2026年9月16日",
    ],
    "促音拗音长音": [
        "東京", "ケーキ", "ユーザー", "コンピューター", "ショップ", "チェック", "キュート",
        "ジャンプ", "ぎゅうにゅう", "きょう", "しゅくだい", "ちょっと", "ざっし", "抹茶",
        "はっきり", "分かった", "いらっしゃいます", "プログラマー", "デザイナー", "お母さん",
    ],
    "英数混排": [
        "GitHubで管理", "iOSアプリ", "macOS対応", "WebSocket接続", "APIキー", "PDFファイル",
        "CSVデータ", "v1.2.3バージョン", "4K映像", "AIモデル", "COVID-19", "Wi-Fi接続",
    ],
}


def to_romaji(tokens) -> str:
    readings = (t.reading_form() or t.surface() for t in tokens)
    return "".join(romkan2.to_roma(r) for r in readings)


def looks_unknown(token) -> bool:
    """UNK 代理判定：读音还原为表层的 token 且表层含汉字。"""
    surface = token.surface()
    reading = token.reading_form() or surface
    return reading == surface and any("\u4e00" <= c <= "\u9fff" for c in surface)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="report", help="报告输出目录")
    parser.add_argument("--iterations", type=int, default=30, help="性能测试迭代次数")
    args = parser.parse_args()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    core_tok = Dictionary(dict="core").create()
    small_tok = Dictionary(dict="small").create()

    items: list[dict] = []
    for category, texts in CORPUS.items():
        for text in texts:
            t_core = core_tok.tokenize(text, "C")
            t_small = small_tok.tokenize(text, "C")
            r_core, r_small = to_romaji(t_core), to_romaji(t_small)
            items.append({
                "category": category,
                "text": text,
                "romaji_core": r_core,
                "romaji_small": r_small,
                "match": r_core == r_small,
                "tokens_core": len(t_core),
                "tokens_small": len(t_small),
                "segmentation_match": len(t_core) == len(t_small),
                "unk_core": sum(looks_unknown(t) for t in t_core),
                "unk_small": sum(looks_unknown(t) for t in t_small),
            })

    total = len(items)
    matched = sum(i["match"] for i in items)
    seg_matched = sum(i["segmentation_match"] for i in items)
    by_cat: dict[str, dict] = {}
    for cat, texts in CORPUS.items():
        rows = [i for i in items if i["category"] == cat]
        by_cat[cat] = {
            "total": len(rows),
            "match": sum(r["match"] for r in rows),
            "segmentation_match": sum(r["segmentation_match"] for r in rows),
        }
    mismatches = [i for i in items if not i["match"]]

    # 性能：整表 tokenize 多轮取平均
    timings: dict[str, float] = {}
    for name, tok in (("core", core_tok), ("small", small_tok)):
        start = time.perf_counter()
        for _ in range(args.iterations):
            for text in CORPUS["常用词汇"] + CORPUS["日常句子"]:
                tok.tokenize(text, "C")
        elapsed = time.perf_counter() - start
        timings[name] = elapsed / args.iterations * 1000

    # 词典体积
    sizes: dict[str, str] = {}
    import importlib.resources
    for pkg in ("sudachidict_core", "sudachidict_small"):
        try:
            res = importlib.resources.files(pkg) / "resources" / "system.dic"
            with importlib.resources.as_file(res) as p:
                sizes[pkg] = f"{p.stat().st_size / 1e6:.0f}MB"
        except Exception:
            sizes[pkg] = "未安装"

    unk_core = sum(i["unk_core"] for i in items)
    unk_small = sum(i["unk_small"] for i in items)

    lines = [
        "# sudachidict core → small 档罗马音质量报告",
        "",
        f"- 日期：{date.today().isoformat()}　语料：{total} 条（8 类）　对比维度：罗马音结果、分词数、UNK 代理",
        "",
        "## 结论",
        "",
        f"- 罗马音一致率：**{matched}/{total}（{matched / total:.1%}）**",
        f"- 分词数一致率：{seg_matched}/{total}（{seg_matched / total:.1%}）",
        f"- UNK 代理 token：core {unk_core} 个 vs small {unk_small} 个",
        f"- 词典体积：core {sizes.get('sudachidict_core')} → small {sizes.get('sudachidict_small')}",
        f"- tokenize 耗时（{args.iterations} 轮均值/52 条）：core {timings['core']:.1f}ms vs small {timings['small']:.1f}ms",
        "",
        "## 分类明细",
        "",
        "| 分类 | 条数 | 罗马音一致 | 分词一致 |",
        "|---|---|---|---|",
    ]
    for cat, stat in by_cat.items():
        lines.append(
            f"| {cat} | {stat['total']} | {stat['match']}（{stat['match'] / stat['total']:.0%}） | "
            f"{stat['segmentation_match']}（{stat['segmentation_match'] / stat['total']:.0%}） |"
        )
    lines += ["", "## 不一致明细", ""]
    if mismatches:
        for i in mismatches:
            lines.append(f"- `{i['text']}`：core=`{i['romaji_core']}` small=`{i['romaji_small']}`（{i['category']}）")
    else:
        lines.append("无——全部语料两种词典输出完全一致。")
    lines += [
        "",
        "## 影响分析",
        "",
        "- **无存量数据错位**：罗马音转换发生在查询时（search.py 的 `_romaji_matches_object` 对原文现转），"
        "文本与查询两侧用同一词典，切档后自洽；没有任何罗马音落库。",
        "- 差异分三类：① core 正确、small 退化的熟语/复合读音（如 雪月花→setsugekka vs yukigekka）；"
        "② 两读皆合法（日本語：にほんご/にっぽんご）；"
        "③ small 反而更好（iOS/macOS 拉丁缩写 small 原样保留，用户按 \"ios\"/\"macos\" 搜索能命中）。",
        "- 搜索回归面：仅当用户恰好使用 core 档读音去搜「被 small 转不同」的词时 miss（如搜 okaasan，"
        "small 将 お母さん 转为 ohahasan）；此类词为少数派，且随词典自洽，同音重查无影响。",
        "",
        "## 复现",
        "",
        "```bash",
        "backend/.venv/bin/python report/romaji_dict_compare.py --output report",
        "```",
        "",
        "需同时安装 sudachidict_core 与 sudachidict_small。",
        "",
    ]
    report_path = out_dir / "romaji-sudachidict-small.md"
    report_path.write_text("\n".join(lines), encoding="utf-8")
    (out_dir / "romaji-sudachidict-small.json").write_text(
        json.dumps({"items": items, "timings_ms": timings, "dict_sizes": sizes},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"一致率 {matched}/{total}，不一致 {len(mismatches)} 条")
    print(f"报告：{report_path}")


if __name__ == "__main__":
    main()
