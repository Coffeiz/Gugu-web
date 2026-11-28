"""只读取显式临时配置，核对Node写入值由实际Python语音设置消费。"""
import os,sys,json
from pathlib import Path
if len(sys.argv)!=4 or sys.argv[1]!='--allow-isolated-test-config':raise SystemExit('仅显式隔离测试可读取配置')
path=Path(sys.argv[2]).resolve()
if not path.parent.name.startswith('voice-main-') or path.name!='override.json':raise SystemExit('配置不在预期临时目录')
os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(path)
os.environ['GUGU_ENV_FILE']=str(path.parent/'no.env')
os.environ['STORAGE__LOCAL_PATH']=str(path.parent/'storage')
from app.core.config import AppSettings,VoicePresets
from agent.voice import is_configured
settings=AppSettings.model_construct(voice_presets=VoicePresets.model_validate(json.loads(path.read_text())['voice_presets']))
assert settings.voice.model==sys.argv[3]
assert is_configured(settings)==bool(sys.argv[3])
print('accepted')
