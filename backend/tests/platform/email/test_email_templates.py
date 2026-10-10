"""邮件语义模板的结构、转义和令牌回归。"""

import pytest

from app.services.email_templates import EMAIL_TOKENS, render_email


def test_notification_renders_standard_html_and_plain_fallback():
    content = render_email(
        subject="项目更新", body="正文第一行\n正文第二行", preheader="最新进展",
        sections=[{"heading": "当前状态", "text": "已经进入执行阶段。"}],
        actions=[{"label": "打开项目", "url": "https://example.com/projects/1"}],
    )

    assert content.plain.startswith("正文第一行\n正文第二行")
    assert "当前状态\n已经进入执行阶段。" in content.plain
    assert "打开项目: https://example.com/projects/1" in content.plain
    assert EMAIL_TOKENS["brand"] in content.html
    assert "最新进展" in content.html
    assert "<script" not in content.html


def test_builtin_images_use_cid_inline_resources_for_mail_clients():
    content = render_email(subject="图片测试", body="正文")

    assert 'src="cid:gugu-logo-mark"' in content.html
    assert 'src="cid:gugu-logo-wordmark"' in content.html
    assert [image.content_id for image in content.inline_images] == [
        "gugu-logo-mark", "gugu-logo-wordmark",
    ]
    assert all(image.data.startswith(b"\x89PNG\r\n\x1a\n") for image in content.inline_images)
    assert "data:image/png;base64," in content.preview_html()
    assert "cid:gugu-logo-mark" not in content.preview_html()


def test_actions_use_email_compatible_standard_button_shell():
    content = render_email(
        subject="操作", body="请继续", actions=[{"label": "立即处理", "url": "https://example.com"}],
    )

    assert 'role="presentation"' in content.html
    assert "padding:9px 13px" in content.html
    assert "border-radius:8px" in content.html
    assert "font-size:12px" in content.html


def test_template_escapes_content_and_rejects_unsafe_action_url():
    content = render_email(subject="<标题>", body="<script>alert(1)</script>")
    assert "&lt;标题&gt;" in content.html
    assert "&lt;script&gt;" in content.html

    with pytest.raises(ValueError, match="操作链接"):
        render_email(
            subject="测试", body="正文",
            actions=[{"label": "危险", "url": "javascript:alert(1)"}],
        )


def test_test_template_is_available():
    content = render_email(template="test", subject="SMTP 测试", body="连接成功")
    assert content.plain == "连接成功"
    assert "连接成功" in content.html


@pytest.mark.parametrize("template", ["reminder", "report", "security"])
def test_phase2_templates_share_the_same_compatible_shell(template):
    content = render_email(
        template=template, subject="状态", body="内容", theme="dark", palette="sage",
        actions=[{"label": "查看", "url": "https://example.com"}],
    )
    assert 'role="presentation"' in content.html
    assert "#171925" in content.html
    assert "#5f967e" in content.html
    assert "内容" in content.plain
