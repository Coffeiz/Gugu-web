"""在隔离 devserver 生成邮件预览资源；输出仅包含参考渲染器的静态着色图片。"""
import base64
import hashlib
import json
from pathlib import Path

from app.services.email import templates

assets = {}
for theme in ("light", "dark"):
    for palette in templates.EMAIL_PALETTES:
        color = templates._email_theme_tokens(theme, palette)["brand"]
        assets[color] = [base64.b64encode(templates._asset_payload(name, color)).decode("ascii")
                         for name in ("logo-large2.png", "logo-text2.png")]
sources = {name: hashlib.sha256((Path(templates.__file__).with_name("assets") / name).read_bytes()).hexdigest()
           for name in ("logo-large2.png", "logo-text2.png")}
print("// 由 compat/support/generate_email_preview_assets.py 调用真实 Python/PIL 生成；不要手工编辑。")
print("// 原图 SHA-256：" + json.dumps(sources, ensure_ascii=False))
print("export const emailPreviewImages: Readonly<Record<string, readonly [string, string]>> = "
      + json.dumps(assets, ensure_ascii=False, separators=(",", ":")))
