"""实际管理员邮件测试handler的MIME/locale基线；不访问外部服务或运行配置。"""
import os,sys,json,tempfile,asyncio,hashlib
from types import SimpleNamespace
with tempfile.TemporaryDirectory(prefix='admin-email-message-') as root:
 os.environ['GUGU_ENV_FILE']=root+'/absent.env'
 os.environ['GUGU_CONFIG_OVERRIDE_FILE']=root+'/absent.json'
 from app.api.v1 import email_admin
 from app.services import email
 settings=SimpleNamespace(host='smtp.example.test',port=465,user='sender@example.test',password='synthetic',from_addr='测试咕咕',to_addr='',use_ssl=True)
 email_admin.get_settings=lambda:SimpleNamespace(smtp=settings)
 email._record_email=lambda *a,**k:None
 captured=[]
 email._deliver=lambda **kw:captured.append(kw['msg'])
 async def main():
  results=[]
  for case in json.loads(sys.stdin.read()):
   result=await email_admin.test_email(email_admin.EmailTestRequest(**case));msg=captured[-1]
   results.append({'result':result,'message':{'subject':str(msg['Subject']),'plain':msg.get_body(preferencelist=('plain',)).get_content().rstrip('\n'),'html':msg.get_body(preferencelist=('html',)).get_content().rstrip('\n'),'images':[{'cid':p['Content-ID'].strip('<>'),'filename':p.get_filename(),'sha256':hashlib.sha256(p.get_payload(decode=True)).hexdigest()} for p in msg.walk() if p.get_content_maintype()=='image']}})
  print(json.dumps(results,ensure_ascii=False))
 asyncio.run(main())
