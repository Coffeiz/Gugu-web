"""实际Python handler的百炼请求及失败响应基线。"""
import json,asyncio
from types import SimpleNamespace

def test_embedding_handler_baseline(tmp_path,monkeypatch):
 monkeypatch.setenv('GUGU_ENV_FILE',str(tmp_path/'no.env'))
 monkeypatch.setenv('GUGU_CONFIG_OVERRIDE_FILE',str(tmp_path/'override.json'))
 monkeypatch.setenv('STORAGE__LOCAL_PATH',str(tmp_path/'storage'))
 from app.api.v1 import config
 from app.core.config import EmbeddingSettings
 monkeypatch.setattr(config,'get_settings',lambda:SimpleNamespace(embedding=EmbeddingSettings(provider='bailian',model='text-embedding-v4',dimensions=8)))
 requests=[]
 class Client:
  def __init__(self,**kwargs):pass
  async def __aenter__(self):return self
  async def __aexit__(self,*args):pass
  async def post(self,url,**kwargs):
   requests.append((url,kwargs))
   return SimpleNamespace(status_code=200,json=lambda:{'output':{'embeddings':[{'embedding':[1,2]}]},'data':[{'embedding':[1,2,3]}]})
 monkeypatch.setattr(config.httpx,'AsyncClient',Client)
 async def run():
  assert await config.test_embedding(config.EmbeddingTestRequest())=={'ok':True,'message':'OK — 连通，向量维度 3'}
  assert requests[0]==('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',{'json':{'model':'text-embedding-v4','input':'连通性测试','dimensions':8,'encoding_format':'float'},'headers':{}})
  assert await config.test_embedding(config.EmbeddingTestRequest(multimodal=True,dimensions=-1))=={'ok':True,'message':'OK — 多模态连通，向量维度 2'}
  assert requests[1][0]=='https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding'
  assert requests[1][1]['json']['parameters']=={'output_type':'dense','dimension':-1}
  for value,expected in [(None,0),('',0),('abc',0),('3.2',0),(3.2,3),('３_２',32),(True,1)]:assert config.EmbeddingTestRequest(dimensions=value).dimensions==expected
 asyncio.run(run())
