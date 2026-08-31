"""新用户首次注册时的播种项目内容。"""
import random

# ── 播种项目名称（随机三选一） ───────────────────────────────────
PROJECT_NAMES = [
    "从这里开始",
    "第一份记录",
    "初次见面",
]

# ── 三个阶段（结构固定为 3 段；每段标签可随机） ───────────────────
STAGE_LABEL_POOLS = [
    ["🌱 这里还有一点空", "🌱 目前还空空的"],
    ["🌿 慢慢有样子了", "🌿 开始丰富起来了", "🌿 有点像样了"],
    ["💬 找我聊聊吧"],
]

# ── 各阶段待办 ─────────────────────────────────────────────────────
STAGE_TODOS = [
    ["随便逛逛", "建个项目试试"],
    ["去日历看看", "去文件库看看"],
    ["我就在右下角 😊", "加个 QQ 好友吧（飞书也行📪）"],
]

# ── 示例文件（正文是 markdown） ───────────────────────────────────
# 欢迎文件（标题 + 正文，二选一）
WELCOME_FILES = [
    {"title": "给未来的自己",
     "body": (
        "# 给未来的自己\n\n"
        "> 希望以后有一天，\n"
        "> 这里会放满你的想法、计划，\n"
        "> 还有很多很多聊天记录。\n\n"
        "不过今天，我们先从这一页开始 🌱\n\n"
        "---\n\n"
        "*—— 咕咕*\n"
     )},
    {"title": "第一份记录",
     "body": (
        "# 第一份记录\n\n"
        "> 每个人都会有第一份记录，\n"
        "> 今天这一页，属于咱们。\n\n"
        "以后这里会慢慢放满你的想法、计划，还有很多很多聊天 😊\n\n"
        "---\n\n"
        "*—— 咕咕*\n"
     )},
]
# 附属文件「可以删掉我」（正文二选一）
SCRATCH_FILE_TITLE = "可以删掉我"
SCRATCH_FILE_BODIES = [
    (
        "# 可以删掉我\n\n"
        "我只是一个示例文件 😊\n\n"
        "留着、改掉，或者删掉，都可以。\n\n"
        "> 💡 对啦，以后想删除整个项目，**项目卡右下角**就能找到删除按钮。\n"
    ),
    (
        "# 可以删掉我\n\n"
        "放心折腾，删掉也不会惹我生气 😊\n\n"
        "> 💡 以后想删除整个项目，**右下角**就能找到入口。\n"
    ),
]

# 播种项目不是界面文案，不能由前端当前语言临时替换；注册时按用户界面语言落库。
SEED_CONTENT = {
    "zh-CN": {
        "project_names": PROJECT_NAMES,
        "stage_labels": STAGE_LABEL_POOLS,
        "stage_todos": STAGE_TODOS,
        "welcome_files": WELCOME_FILES,
        "scratch_title": SCRATCH_FILE_TITLE,
        "scratch_bodies": SCRATCH_FILE_BODIES,
        "calendar_title": "和咕咕的第一天",
    },
    "ja-JP": {
        "project_names": ["ここから始める", "最初の記録", "はじめまして"],
        "stage_labels": [["🌱 まだ空っぽ", "🌱 まだ何もない"], ["🌿 少しずつ形に", "🌿 だんだん豊かに", "🌿 いい感じになってきた"], ["💬 話しかけてね"]],
        "stage_todos": [["少し見て回る", "プロジェクトを作ってみる"], ["カレンダーを見る", "ファイル庫を見る"], ["右下にいるよ 😊", "QQで友だちになる（FeishuでもOK📪）"]],
        "welcome_files": [{"title": "未来の自分へ", "body": "# 未来の自分へ\n\n> いつかここが、\n> 思いつきや予定、\n> たくさんの会話でいっぱいになりますように。\n\n今日はこのページから始めよう 🌱\n\n---\n\n*—— グーグー*\n"}, {"title": "最初の記録", "body": "# 最初の記録\n\n> 誰にでも最初の記録があります。\n> 今日のこのページは、私たちのもの。\n\nここは少しずつ、思いつきや予定、会話でいっぱいになります 😊\n\n---\n\n*—— グーグー*\n"}],
        "scratch_title": "削除しても大丈夫",
        "scratch_bodies": ["# 削除しても大丈夫\n\nこれはサンプルファイルです 😊\n\n残しても、書き換えても、削除しても大丈夫。\n", "# 削除しても大丈夫\n\n気軽に試してみてね。削除しても怒らないよ 😊\n"],
        "calendar_title": "グーグーとの最初の日",
    },
    "en-US": {
        "project_names": ["Start here", "First record", "Nice to meet you"],
        "stage_labels": [["🌱 Still open", "🌱 Nothing here yet"], ["🌿 Taking shape", "🌿 Starting to grow", "🌿 Looking good"], ["💬 Come chat with me"]],
        "stage_todos": [["Take a look around", "Try creating a project"], ["Check the calendar", "Check the file library"], ["I’m in the bottom-right 😊", "Add me on QQ (Feishu works too 📪)"]],
        "welcome_files": [{"title": "To my future self", "body": "# To my future self\n\n> May this space one day be filled\n> with ideas, plans,\n> and many conversations.\n\nFor today, let’s start with this page 🌱\n\n---\n\n*—— Gugu*\n"}, {"title": "First record", "body": "# First record\n\n> Everyone has a first record.\n> This page belongs to us.\n\nLittle by little, this space will fill with ideas, plans, and chats 😊\n\n---\n\n*—— Gugu*\n"}],
        "scratch_title": "You can delete me",
        "scratch_bodies": ["# You can delete me\n\nI’m just a sample file 😊\n\nKeep, edit, or delete me—anything is fine.\n", "# You can delete me\n\nFeel free to experiment. I won’t mind if you delete me 😊\n"],
        "calendar_title": "Our first day together",
    },
}


def seed_content(locale: str | None):
    """返回播种项目及其附属文件的本地化内容，未知语言回退中文。"""
    return SEED_CONTENT.get(locale or "zh-CN", SEED_CONTENT["zh-CN"])

def pick(seq):
    """从非空序列随机取一条；空 → None。"""
    return random.choice(seq) if seq else None
