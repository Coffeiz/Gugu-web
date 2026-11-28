"""真实测试邮件handler+SMTP；只接受本任务临时配置及合成邮箱。"""
import os,sys,json,asyncio
from pathlib import Path
path=Path(sys.argv[1]).resolve()
if not path.parent.name.startswith('smtp-probe-') or path.name!='override.json':raise SystemExit('拒绝非测试配置')
os.environ['GUGU_ENV_FILE']=str(path.parent/'absent.env')
os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(path)
os.environ['DB__PASSWORD']='synthetic-isolated-password'
from app.api.v1 import email_admin
from app.services import email
email._record_email=lambda *a,**k:None
case=json.loads(sys.stdin.read())
if not case.get('recipient','').endswith('@example.test'):raise SystemExit('仅允许合成收件人')
settings=email_admin.get_settings().smtp
if settings.host not in ('','127.0.0.1'):raise SystemExit('仅允许隔离SMTP')
print(json.dumps(asyncio.run(email_admin.test_email(email_admin.EmailTestRequest(**case))),ensure_ascii=False))
