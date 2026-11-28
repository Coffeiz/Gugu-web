"""只读显式临时配置，检查实际Python安全出站认证消费者互通。"""
import os,sys,json
from pathlib import Path
from types import SimpleNamespace
if len(sys.argv)!=3 or sys.argv[1]!='--allow-isolated-test-config':raise SystemExit('仅允许显式隔离测试')
path=Path(sys.argv[2]).resolve()
if not path.parent.name.startswith('egress-main-') or path.name!='override.json':raise SystemExit('配置不在预期临时目录')
os.environ['GUGU_ENV_FILE']=str(path.parent/'no.env')
os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(path)
os.environ['STORAGE__LOCAL_PATH']=str(path.parent/'storage')
from app.core import crypto,safe_egress
from app.core.config import SafeEgressSettings
crypto.get_settings=lambda:SimpleNamespace(secret_key='synthetic-egress-secret')
settings=SafeEgressSettings.model_validate(json.loads(path.read_text())['safe_egress'])
expected=json.loads(sys.stdin.read())
assert settings.proxy_url==expected['proxy_url']
assert safe_egress._proxy_auth(settings)==(tuple(expected['auth']) if expected['auth'] else None)
print('accepted')
