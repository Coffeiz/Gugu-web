from types import SimpleNamespace

from app.utils import romaji


def test_to_romaji_uses_sudachi_reading_and_normalizes_romkan_output(monkeypatch):
    class FakeToken:
        def __init__(self, surface, reading):
            self._surface = surface
            self._reading = reading

        def surface(self):
            return self._surface

        def reading_form(self):
            return self._reading

    class FakeTokenizer:
        def tokenize(self, text, mode):
            assert text == "東京タワー"
            assert mode == "C"
            return [FakeToken("東京", "トウキョウ"), FakeToken("タワー", "タワー")]

    monkeypatch.setattr(romaji, "_lazy_pinyin", lambda text, errors: [text])
    monkeypatch.setattr(romaji, "_HAS_PINYIN", True)
    monkeypatch.setattr(romaji, "_HAS_JAPANESE_ROMAJI", True)
    monkeypatch.setattr(romaji, "_sudachi_tokenizer", FakeTokenizer())
    monkeypatch.setattr(romaji, "_SudachiSplitMode", SimpleNamespace(C="C"))
    monkeypatch.setattr(romaji, "_romkan2", SimpleNamespace(to_roma=lambda text: {
        "トウキョウ": "toukyou",
        "タワー": "tawa-",
    }[text]))

    assert romaji.to_romaji("東京タワー") == "toukyoutawa"


def test_to_romaji_keeps_chinese_pinyin_flow_without_japanese_converter(monkeypatch):
    monkeypatch.setattr(romaji, "_HAS_PINYIN", True)
    monkeypatch.setattr(romaji, "_lazy_pinyin", lambda text, errors: ["bei", "jing"])
    monkeypatch.setattr(romaji, "_HAS_JAPANESE_ROMAJI", False)

    assert romaji.to_romaji("北京") == "beijing"


def test_romaji_match_accepts_japanese_reading_for_pure_kanji(monkeypatch):
    class FakeToken:
        def reading_form(self):
            return "トウキョウ"

        def surface(self):
            return "東京"

    class FakeTokenizer:
        def tokenize(self, text, mode):
            return [FakeToken()]

    monkeypatch.setattr(romaji, "_HAS_PINYIN", True)
    monkeypatch.setattr(romaji, "_lazy_pinyin", lambda text, errors: ["dong", "jing"])
    monkeypatch.setattr(romaji, "_HAS_JAPANESE_ROMAJI", True)
    monkeypatch.setattr(romaji, "_sudachi_tokenizer", FakeTokenizer())
    monkeypatch.setattr(romaji, "_SudachiSplitMode", SimpleNamespace(C="C"))
    monkeypatch.setattr(romaji, "_romkan2", SimpleNamespace(to_roma=lambda text: "toukyou"))

    assert romaji.to_romaji("東京") == "dongjing"
    assert romaji.romaji_match("東京", "toukyou")


def test_to_romaji_uses_japanese_dictionary_for_japanese_locale(monkeypatch):
    monkeypatch.setattr(romaji, "_HAS_PINYIN", True)
    monkeypatch.setattr(romaji, "_lazy_pinyin", lambda text, errors: ["dong", "jing"])
    monkeypatch.setattr(romaji, "_HAS_JAPANESE_ROMAJI", True)
    monkeypatch.setattr(romaji, "_sudachi_tokenizer", type("Tokenizer", (), {
        "tokenize": lambda self, text, mode: [type("Token", (), {
            "reading_form": lambda self: "トウキョウ",
            "surface": lambda self: "東京",
        })()]
    })())
    monkeypatch.setattr(romaji, "_SudachiSplitMode", SimpleNamespace(C="C"))
    monkeypatch.setattr(romaji, "_romkan2", SimpleNamespace(to_roma=lambda text: "toukyou"))

    assert romaji.to_romaji("東京", "ja-JP") == "toukyou"
