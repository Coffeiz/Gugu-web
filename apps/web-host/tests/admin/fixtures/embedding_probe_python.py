"""实际Python诊断handler基线；仅显式临时配置与合成服务，不读取运行配置。"""
import os,sys,json,asyncio
from pathlib import Path
if len(sys.argv)!=3 or sys.argv[1]!='--allow-isolated-test-config':raise SystemExit('仅限显式隔离测试')
path=Path(sys.argv[2]).resolve()
if not path.parent.name.startswith('embedding-probe-') or path.name!='override.json':raise SystemExit('拒绝非测试配置')
os.environ['GUGU_ENV_FILE']=str(path.parent/'no.env')
os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(path)
os.environ['STORAGE__LOCAL_PATH']=str(path.parent/'storage')
from app.api.v1 import config
from app.core.config import EmbeddingSettings
from types import SimpleNamespace
settings=EmbeddingSettings.model_validate(json.loads(path.read_text()).get('embedding',{}))
config.get_settings=lambda:SimpleNamespace(embedding=settings)
async def main():
 cases=json.loads(sys.stdin.read())
 print(json.dumps([await config.test_embedding(config.EmbeddingTestRequest(**case)) for case in cases],ensure_ascii=False))
asyncio.run(main())
