"""下载票据跨语言字节契约，均为合成密钥和用户。"""
import json
import os
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest


@pytest.mark.process
def test_ticket_signature_and_reusable_verification_match_node(tmp_path, monkeypatch):
    monkeypatch.setenv("GUGU_ENV_FILE", os.devnull)
    monkeypatch.setenv("GUGU_CONFIG_OVERRIDE_FILE", str(tmp_path / "not-created.json"))
    from app.api.v1 import data_portability as api
    from app.core import config
    secret = "synthetic-ticket-secret"
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(secret_key=secret))
    owner, job, expiry = uuid4(), uuid4(), int(time.time()) + 120
    ticket = api._download_ticket(owner, job, expiry)
    script = """
import {signExportDownloadTicket,verifyExportDownloadTicket} from './src/modules/data-portability/download-ticket.ts';
const secret='synthetic-ticket-secret',owner=process.env.GUGU_TEST_OWNER,job=process.env.GUGU_TEST_JOB;
console.log(JSON.stringify({ticket:signExportDownloadTicket(secret,owner,job,Number(process.env.GUGU_TEST_EXPIRY)),owner:verifyExportDownloadTicket(secret,process.env.GUGU_TEST_TICKET,job)}));
"""
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "--eval", script], cwd=Path(__file__).resolve().parents[2] / "apps/web-host", env={**os.environ, "GUGU_TEST_OWNER": str(owner), "GUGU_TEST_JOB": str(job), "GUGU_TEST_EXPIRY": str(expiry), "GUGU_TEST_TICKET": ticket}, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, "Node下载票据对照失败"
    value = json.loads(result.stdout)
    assert value == {"ticket": ticket, "owner": str(owner)}
    assert api._verify_download_ticket(value["ticket"], job) == owner
    assert api._verify_download_ticket(value["ticket"], job) == owner
    assert api._verify_download_ticket(value["ticket"], uuid4()) is None
