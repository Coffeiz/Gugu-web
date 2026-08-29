import io
import re

from app.core.logging import _TimestampedStream


def test_timestamped_stream_prefixes_split_print_line():
    target = io.StringIO()
    stream = _TimestampedStream(target)

    assert stream.write("worker message") == len("worker message")
    stream.write("\n")
    stream.flush()

    output = target.getvalue()
    assert re.match(r"^\d{2}-\d{2} \d{2}:\d{2}:\d{2} worker message\n$", output)


def test_timestamped_stream_does_not_double_prefix_existing_timestamp():
    target = io.StringIO()
    stream = _TimestampedStream(target)

    stream.write("08-23 12:34:56 already formatted\n")
    stream.flush()

    assert target.getvalue() == "08-23 12:34:56 already formatted\n"


def test_timestamped_stream_flushes_partial_line():
    target = io.StringIO()
    stream = _TimestampedStream(target)

    stream.write("partial")
    stream.flush()

    assert re.match(r"^\d{2}-\d{2} \d{2}:\d{2}:\d{2} partial$", target.getvalue())
