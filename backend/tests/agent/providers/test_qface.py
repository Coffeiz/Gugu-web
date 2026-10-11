from agent.im.emoji.qface import _select_asset


def test_qface_matches_emoji_id_and_prefers_apng_asset():
    asset = _select_asset([
        {
            "emojiId": "14",
            "qzoneCode": "114",
            "assets": [
                {"type": 0, "name": "14.png", "path": "assets/qq_emoji/14/png/14.png"},
                {"type": 2, "name": "14.png", "path": "assets/qq_emoji/14/apng/14.png"},
            ],
        }
    ], "14")

    assert asset is not None
    assert asset.url.endswith("assets/qq_emoji/14/apng/14.png")


def test_qface_rejects_market_type_and_unsafe_asset_path():
    assert _select_asset([{"emojiId": "14", "assets": []}], "14") is None
    assert _select_asset([{
        "emojiId": "14",
        "assets": [{"type": 0, "name": "bad", "path": "assets/../secret.png"}],
    }], "14") is None


def test_qface_prefers_exact_emoji_id_over_qzone_code_collision():
    asset = _select_asset([
        {
            "emojiId": "78",
            "qzoneCode": "181",
            "assets": [{"type": 0, "name": "78.png", "path": "assets/qq_emoji/78/png/78.png"}],
        },
        {
            "emojiId": "181",
            "qzoneCode": "251",
            "assets": [{"type": 0, "name": "181.png", "path": "assets/qq_emoji/181/png/181.png"}],
        },
    ], "181")

    assert asset is not None
    assert asset.url.endswith("assets/qq_emoji/181/png/181.png")
