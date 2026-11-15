from types import SimpleNamespace
import pytest
pytest_plugins=['tests.conftest']
@pytest.mark.asyncio
async def test_user_bots_read(db,user_a,user_b,monkeypatch):
 from app.api.v1.user_bots import list_my_bots
 from app.models import UserBot
 from app.services import im_platforms
 monkeypatch.setattr(im_platforms,'get_settings',lambda:SimpleNamespace(im=SimpleNamespace(qq=True,telegram=True,feishu=False,wechat=False)))
 bot=UserBot(user_id=user_a.id,platform='qq',name='测试机器人',app_id='synthetic-app',app_secret='abcdefghi',group_requires_at=True,group_read_enabled=True,group_attention_mode='old',group_allowed_tools=['web_search','web_search','similar_image_search','delete_file'],group_message_format='old',private_message_format='old',owner_platform_user_id='synthetic-owner')
 db.add_all([bot,UserBot(user_id=user_b.id,platform='qq',name='他人机器人',app_secret='other-secret')]);await db.commit()
 result=await list_my_bots(user_a,db)
 assert result['supported_platforms']==['qq','telegram'] and len(result['items'])==1
 out=result['items'][0]
 assert out['app_secret']=='abc••••••hi' and out['owner_bound'] is True
 assert out['group_response_mode']=='record_only' and out['group_attention_mode']=='autonomous'
 assert out['group_allowed_tools']==['web_search','http_get','similar_image_search','read_file']
 assert out['group_message_format']=='compat' and out['private_message_format']=='markdown'

def test_python_encryption_fixture(monkeypatch):
 from app.core import crypto
 monkeypatch.setattr(crypto,'get_settings',lambda:SimpleNamespace(secret_key='synthetic-bot-secret'))
 token=crypto.encrypt_secret('abcdefghi')
 assert crypto.decrypt_secret(token)=='abcdefghi'
 assert crypto.decrypt_secret('gcm1:broken')=='gcm1:broken'
 # 常量仅含合成测试密文，用于Node跨语言解密验收。
 from pathlib import Path
 Path('/tmp/n2-bot-python-ciphertext.txt').write_text(token)

def test_im_override_priority_and_invalid_values(tmp_path,monkeypatch):
 import json
 from app.core import config
 path=tmp_path/'override.json'
 monkeypatch.setattr(config,'OVERRIDE_FILE',path)
 base=config.AppSettings.model_construct(im=config.IMPlatformSettings(feishu=False,qq=False,wechat=True,telegram=True))
 for im,expected in [({'qq':'YES','telegram':False},['qq','wechat']),(None,['wechat','telegram']),({'qq':None},['wechat','telegram']),({'wechat':False},['telegram'])]:
  path.write_text(json.dumps({'im':im}))
  effective=base.apply_override().im
  assert [name for name in ['feishu','qq','wechat','telegram'] if getattr(effective,name)]==expected

@pytest.mark.asyncio
async def test_unbind_qq_identity_owner_and_idempotency(db,user_a,user_b,monkeypatch):
 from app.api.v1.user_bots import unbind_qq_identity
 from app.models import UserBot
 from app.core import events
 from fastapi import HTTPException
 calls=[]
 async def publish(*args,**kwargs):calls.append((args,kwargs))
 monkeypatch.setattr(events,'publish',publish)
 own=UserBot(user_id=user_a.id,platform='qq',app_secret='synthetic-secret',owner_platform_user_id='synthetic-owner')
 foreign=UserBot(user_id=user_b.id,platform='qq',owner_platform_user_id='other-owner')
 nonqq=UserBot(user_id=user_a.id,platform='telegram',owner_platform_user_id='third-owner')
 db.add_all([own,foreign,nonqq]);await db.commit()
 for bot in [foreign,nonqq]:
  with pytest.raises(HTTPException) as denied:await unbind_qq_identity(bot.id,user_a,db)
  assert denied.value.status_code==404
 for _ in range(2):assert await unbind_qq_identity(own.id,user_a,db) is None
 await db.refresh(own)
 assert own.owner_platform_user_id is None and own.owner_bound_at is None and own.app_secret=='synthetic-secret'
 assert len(calls)==2 and calls[0][1]=={'operation':'refresh'}
