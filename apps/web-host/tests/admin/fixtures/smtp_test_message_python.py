"""只生成固定测试邮件，不读取运行配置或访问 SMTP。"""
import os,sys,json,hashlib,tempfile
with tempfile.TemporaryDirectory(prefix='smtp-message-') as root:
 os.environ['GUGU_ENV_FILE']=root+'/absent.env'
 os.environ['GUGU_CONFIG_OVERRIDE_FILE']=root+'/absent.json'
 from app.services import email
 captured=[]
 email._deliver=lambda **kwargs:captured.append(kwargs['msg'])
 email.send_test_email(host='smtp.example.test',port=465,user='sender@example.test',password='synthetic',from_addr='测试咕咕',to_addr='recipient@example.test',use_ssl=True)
 msg=captured[0]
 print(json.dumps({'subject':str(msg['Subject']),'plain':msg.get_body(preferencelist=('plain',)).get_content().rstrip('\n'),'html':msg.get_body(preferencelist=('html',)).get_content().rstrip('\n'),'images':[{'cid':part['Content-ID'].strip('<>'),'filename':part.get_filename(),'sha256':hashlib.sha256(part.get_payload(decode=True)).hexdigest()} for part in msg.walk() if part.get_content_maintype()=='image']},ensure_ascii=False))
