"""仅在临时配置夹具上验证真实Python flock与Node互斥。"""
import os,sys,time
from pathlib import Path
if len(sys.argv)!=3 or sys.argv[1]!='--allow-isolated-test-config':
 raise SystemExit('仅显式隔离测试允许写入配置')
path=Path(sys.argv[2]).resolve()
if not path.parent.name.startswith('voice-mutate-') or path.name!='override.json':
 raise SystemExit('配置不在预期临时目录')
os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(path)
os.environ['GUGU_ENV_FILE']=str(path.parent/'no.env')
os.environ['STORAGE__LOCAL_PATH']=str(path.parent/'storage')
from app.core.config import mutate_override_json

def update(document):
 print('locked',flush=True)
 time.sleep(.3)
 document['db']['writer']='python'
mutate_override_json(update)
