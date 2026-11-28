"""实际管理员SMTP handler，仅允许显式隔离配置与合成收件地址。"""
import os,sys,json,asyncio
from pathlib import Path
if len(sys.argv)!=2:raise SystemExit('需要隔离配置')
path=Path(sys.argv[1]).resolve()
if not path.parent.name.startswith('smtp-probe-') or path.name!='override.json':raise SystemExit('拒绝非测试配置')
os.environ['DB__PASSWORD']='synthetic-isolated-password'
os.environ['GUGU_ENV_FILE']=str(path.parent/'absent.env')
os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(path)
from app.api.v1 import config
case=json.loads(sys.stdin.read())
if case.get('host') not in ('','127.0.0.1'):raise SystemExit('仅允许隔离SMTP')
print(json.dumps(asyncio.run(config.test_smtp(config.SmtpTestParams(**case))),ensure_ascii=False))
