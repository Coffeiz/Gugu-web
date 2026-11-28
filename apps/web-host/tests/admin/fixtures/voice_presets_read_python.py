import json
import pytest
from app.api.v1 import agent_admin
pytest_plugins=['tests.conftest']

@pytest.mark.asyncio
async def test_voice_presets_read_is_masked_and_read_only(tmp_path,monkeypatch):
 path=tmp_path/'override.json'
 document={'db':{'marker':'preserve'},'voice_presets':{'active_id':'v_one','items':[{'id':'v_one','name':'测试语音','api_key':'synthetic-key','extension':'preserve'},{'id':'v_two','api_key':'🔑🔑'},{'id':'v_three','api_key':''},None,8]}}
 path.write_text(json.dumps(document))
 monkeypatch.setattr(agent_admin,'_read_override',lambda:json.loads(path.read_text()))
 before=path.read_bytes()
 result=await agent_admin.list_voice_presets()
 assert result['active_id']=='v_one' and len(result['items'])==3
 assert result['items'][0]['api_key']=='syn••••••-key' and result['items'][0]['has_api_key'] is True and result['items'][0]['active'] is True
 assert result['items'][0]['extension']=='preserve' and result['items'][1]['api_key']=='••' and result['items'][2]['has_api_key'] is False
 assert path.read_bytes()==before

@pytest.mark.asyncio
async def test_voice_presets_missing_or_bad_collection_is_empty(monkeypatch):
 for document in [{},{'voice_presets':{'active_id':'stale','items':None}},{'voice_presets':None}]:
  monkeypatch.setattr(agent_admin,'_read_override',lambda:document)
  assert await agent_admin.list_voice_presets()=={'active_id':'','items':[]}

@pytest.mark.asyncio
async def test_voice_mutations_real_file_preserve_other_sections_and_runtime_selection(tmp_path,monkeypatch):
 from app.core import config
 path=tmp_path/'override.json'
 monkeypatch.setattr(config,'OVERRIDE_FILE',path)
 path.write_text(json.dumps({'db':{'marker':'preserve'},'llm_presets':{'items':[{'id':'keep'}]}}))
 first=await agent_admin.create_voice_preset(agent_admin.VoicePresetPayload(name=' 测试语音 ',provider='qwen',api_key='synthetic-test-key',base_url='https://voice.example.test',model='qwen3-asr-flash',api_format='dashscope'))
 preset_id=first['item']['id'];assert first['active_id']==preset_id and first['item']['name']=='测试语音'
 before=path.read_bytes()
 from fastapi import HTTPException
 with pytest.raises(HTTPException) as denied:await agent_admin.update_voice_preset(preset_id,agent_admin.VoicePresetUpdate(base_url='https://other.example.test',api_key=''))
 assert denied.value.status_code==422 and path.read_bytes()==before
 updated=await agent_admin.update_voice_preset(preset_id,agent_admin.VoicePresetUpdate(model='fun-asr-flash',api_key=''))
 assert updated['item']['dashscope_service']=='fun-asr' and updated['item']['has_api_key'] is True
 saved=json.loads(path.read_text());settings=config.AppSettings.model_construct(voice_presets=config.VoicePresets.model_validate(saved['voice_presets']))
 from agent.voice import is_configured
 assert is_configured(settings) is True and settings.voice.model=='fun-asr-flash'
 await agent_admin.deactivate_voice_preset()
 assert json.loads(path.read_text())['voice_presets']['active_id']==''
 assert await agent_admin.activate_voice_preset(preset_id)=={'active_id':preset_id}
 assert await agent_admin.delete_voice_preset(preset_id)=={'deleted':preset_id,'active_id':''}
 final=json.loads(path.read_text());assert final['db']=={'marker':'preserve'} and final['llm_presets']=={'items':[{'id':'keep'}]}
