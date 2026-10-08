from app.services.files.upload import parse_upload_filename


def test_parse_upload_filename_uses_display_name_and_normalized_extension():
    assert parse_upload_filename('方案.v1.md') == ('方案.v1', 'MD')
    assert parse_upload_filename('README') == ('README', 'FILE')
    assert parse_upload_filename('archive.verylongextension') == ('archive', 'VERYLONGEX')


def test_parse_upload_filename_keeps_single_leading_dot_as_extensionless_name():
    assert parse_upload_filename('.gitconfig') == ('.gitconfig', 'FILE')
    assert parse_upload_filename('.env') == ('.env', 'FILE')
    assert parse_upload_filename('.env.local') == ('.env', 'LOCAL')
