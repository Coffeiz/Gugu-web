from app.services.files.upload import parse_upload_filename


def test_parse_upload_filename_uses_display_name_and_normalized_extension():
    assert parse_upload_filename('方案.v1.md') == ('方案.v1', 'MD')
    assert parse_upload_filename('README') == ('README', 'FILE')
    assert parse_upload_filename('archive.verylongextension') == ('archive', 'VERYLONGEX')
