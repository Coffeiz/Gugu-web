"""阶段/待办计数的Unicode版本基准，不访问用户数据。"""

import pytest

from app.core.date_input import normalize_date_string
from app.core.projects import next_project_stage_key, next_project_todo_number


def test_project_counters_ignore_new_unicode_digits_and_keep_decimal_groups():
    newer = "\U00011de9"
    stages = [{"key": "s2", "todos": [{"id": "t2"}]},
              {"key": "s1" + newer, "todos": [{"id": "t" + newer}]}]
    assert next_project_stage_key(stages) == "s3"
    assert next_project_todo_number(stages) == 2
    assert next_project_stage_key([{"key": "s٢"}, {"key": "s𝟜"}]) == "s5"
    assert next_project_todo_number([{"todos": [{"id": "t９"}]}]) == 9


@pytest.mark.parametrize("suffix", ["²", "①", "1²"])
def test_project_counters_reject_digit_that_cannot_convert_to_decimal(suffix):
    with pytest.raises(ValueError):
        next_project_stage_key([{"key": "s" + suffix}])
    with pytest.raises(ValueError):
        next_project_todo_number([{"todos": [{"id": "t" + suffix}]}])


@pytest.mark.parametrize("value", ["2026年8月23日", "2026-08-23", "8月23日", "08/23"])
def test_date_input_does_not_accept_new_unicode_digits(value):
    newer = "".join(chr(0x11de0 + int(character)) if character in "0123456789" else character
                    for character in value)
    with pytest.raises(ValueError):
        normalize_date_string(newer, default_year=2026)
