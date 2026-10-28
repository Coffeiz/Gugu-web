from agent.im.parsers.qq import _normalize_qq_attachment_placeholders


def test_qq_attachment_placeholder_is_removed_only_when_matching_a_real_attachment():
    marker = '<attachmentType="image/jpeg",attachmentIndex=0,description="opaque">'
    attachments = [{"content_type": "image/jpeg", "filename": "image.jpg"}]

    assert _normalize_qq_attachment_placeholders(marker, attachments) == ""
    assert _normalize_qq_attachment_placeholders(f"请看图 {marker}", attachments) == "请看图"


def test_qq_attachment_placeholder_is_preserved_without_matching_attachment():
    marker = '<attachmentType="image/jpeg",attachmentIndex=0,description="opaque">'

    assert _normalize_qq_attachment_placeholders(marker, []) == marker
    assert _normalize_qq_attachment_placeholders(
        marker, [{"content_type": "image/png", "filename": "image.png"}],
    ) == marker
    assert _normalize_qq_attachment_placeholders(
        '<attachmentType="image/jpeg",attachmentIndex=1,description="opaque">',
        [{"content_type": "image/jpeg", "filename": "image.jpg"}],
    ) == '<attachmentType="image/jpeg",attachmentIndex=1,description="opaque">'
    assert _normalize_qq_attachment_placeholders(
        marker,
        [
            {"content_type": "image/jpeg", "filename": "image.jpg"},
            {"content_type": "image/jpeg", "filename": "second.jpg"},
        ],
    ) == ""
