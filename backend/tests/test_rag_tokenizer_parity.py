import asyncio
import json
from pathlib import Path

import pytest



ROOT = Path(__file__).parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "rag_tokenizer_golden.json"
TS_ENTRY = ROOT / "ts" / "workers" / "rag" / "src" / "index.ts"


def _golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


async def _ts_tokenize(text: str) -> list[str]:
    process = await asyncio.create_subprocess_exec(
        "node", "--experimental-strip-types", str(TS_ENTRY),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
    )
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write((json.dumps({"op": "tokenize", "text": text}, ensure_ascii=False) + "\n").encode())
    await process.stdin.drain()
    line = await process.stdout.readline()
    process.terminate()
    await process.wait()
    return json.loads(line)["tokens"]


@pytest.mark.asyncio
async def test_ts_tokenizer_matches_golden_corpus():
    for case in _golden():
        assert await _ts_tokenize(case["text"]) == case["tokens"], case["text"]
