from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[4]
COMPOSE_FILES = (
    "docker-compose.yml",
    "docker-compose.dev.yml",
    "docker-compose.prod.yml",
)
IMAGE_ENGINES_ENABLED_BY_COMPOSE = {
    "baidu images",
    "quark images",
    "sogou images",
    "google images",
    "qwant images",
    "yandex images",
    "openverse",
    "flickr",
    "imgur",
    "artstation",
}


@pytest.mark.parametrize("compose_file", COMPOSE_FILES)
def test_compose_searxng_exposes_json_and_enables_default_image_engines(compose_file):
    compose = yaml.safe_load((ROOT / compose_file).read_text())
    settings_text = compose["configs"]["searxng-settings"]["content"]
    searxng_settings = yaml.safe_load(settings_text)
    overrides = {engine["name"]: engine for engine in searxng_settings["engines"]}

    assert "json" in searxng_settings["search"]["formats"]
    assert IMAGE_ENGINES_ENABLED_BY_COMPOSE <= overrides.keys()
    assert all(overrides[name]["disabled"] is False for name in IMAGE_ENGINES_ENABLED_BY_COMPOSE)
    assert "searxng-settings" in {
        mount["source"] for mount in compose["services"]["searxng"]["configs"]
    }
