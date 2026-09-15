from __future__ import annotations

import asyncio
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi import HTTPException

from app.services.files import previews
from app.api.v1 import files as files_api


def _xlsx_bytes(sheet_xml: str) -> bytes:
    output = io.BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr(
            "xl/workbook.xml",
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="工作表1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return output.getvalue()


def test_xlsx_preview_rejects_oversized_zip_entry(monkeypatch):
    monkeypatch.setattr(previews, "XLSX_PREVIEW_MAX_ENTRY_UNCOMPRESSED", 32)
    data = _xlsx_bytes('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                       f'<sheetData><row r="1"><c r="A1"><v>{"1" * 128}</v></c></row></sheetData></worksheet>')

    with pytest.raises(previews.PreviewError, match="压缩条目"):
        previews._extract_xlsx_sheet_data_sync(data)


def test_xlsx_preview_rejects_high_compression_ratio(monkeypatch):
    monkeypatch.setattr(previews, "XLSX_PREVIEW_MAX_COMPRESSION_RATIO", 2)
    output = io.BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("xl/workbook.xml", b"0" * 20_000)

    with pytest.raises(previews.PreviewError, match="压缩比"):
        previews._extract_xlsx_sheet_data_sync(output.getvalue())


def test_xlsx_sheet_data_is_limited_before_response_dict_is_built():
    sheet_xml = (
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        '<row r="1"><c r="A1"><v>kept</v></c><c r="BH500"><v>kept-edge</v></c></row>'
        '<row r="501"><c r="A501"><v>discarded</v></c></row>'
        '<row r="2"><c r="BI2"><v>discarded</v></c></row>'
        '</sheetData></worksheet>'
    )
    result = previews._extract_xlsx_sheet_data_sync(_xlsx_bytes(sheet_xml))[0]

    assert result["cells"] == {"A1": "kept", "BH500": "kept-edge"}
    assert result["rows"] == 500
    assert result["cols"] == 60


@pytest.mark.asyncio
async def test_xlsx_preview_single_flight_and_byte_budget(monkeypatch):
    class Storage:
        calls = 0

        async def get(self, _key):
            self.calls += 1
            await asyncio.sleep(0)
            return b"raw-xlsx"

    monkeypatch.setattr(previews, "_extract_xlsx_preview_sync", lambda _raw: ([], {}))
    monkeypatch.setattr(previews, "_extract_xlsx_sheet_data_sync", lambda _raw: [])
    monkeypatch.setattr(previews, "XLSX_PREVIEW_CACHE_MAX_BYTES", 8)
    previews._XLSX_PREVIEW_CACHE.clear()
    previews._XLSX_PREVIEW_INFLIGHT.clear()
    storage = Storage()
    try:
        await asyncio.gather(
            previews.read_xlsx_preview(storage, storage_key="a", file_id=1, version=1),
            previews.read_xlsx_preview(storage, storage_key="a", file_id=1, version=1),
        )
        assert storage.calls == 1
        assert (1, 1) in previews._XLSX_PREVIEW_CACHE
    finally:
        previews._XLSX_PREVIEW_CACHE.clear()
        previews._XLSX_PREVIEW_INFLIGHT.clear()


@pytest.mark.asyncio
async def test_xlsx_preview_maps_preview_limit_error_to_http_status(monkeypatch):
    monkeypatch.setattr(
        files_api,
        "get_owned",
        AsyncMock(return_value=SimpleNamespace(ext="xlsx", storage_key="xlsx", version=1, deleted_at=None)),
    )
    monkeypatch.setattr(
        files_api,
        "read_xlsx_preview",
        AsyncMock(side_effect=previews.PreviewError(413, "XLSX 文件超过预览大小限制")),
    )

    with pytest.raises(HTTPException) as error:
        await files_api.xlsx_preview(1, SimpleNamespace(id=1), None)

    assert error.value.status_code == 413
    assert error.value.detail == "XLSX 文件超过预览大小限制"
