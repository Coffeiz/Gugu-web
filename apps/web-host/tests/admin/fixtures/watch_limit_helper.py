"""实际Python helper+Handler，只允许临时proc/sysctl/策略，绝不触真实sysctl。"""
import os,sys,json,threading,importlib.util
from unittest.mock import patch
from pathlib import Path
if len(sys.argv)!=3 or sys.argv[1] not in {'--serve-isolated','--call-isolated'}:raise SystemExit('仅限显式隔离测试')
mode=sys.argv[1];root=Path(sys.argv[2]).resolve()
if root.parent!=Path('/tmp') or not root.name.startswith('watch-main-'):raise SystemExit('拒绝非临时目录')
os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(root/'override.json')
os.environ['GUGU_ENV_FILE']=str(root/'no.env')
os.environ['STORAGE__LOCAL_PATH']=str(root/'storage')
if mode=='--call-isolated':
 import asyncio
 from app.api.v1 import filesync_admin
 from app.services.filesync import inotify_limit_client
 from fastapi import HTTPException
 inotify_limit_client.SOCKET_PATH=str(root/'helper.sock')
 async def call():
  try:print(json.dumps({'status':200,'body':await filesync_admin.expand_watcher_capacity()}))
  except HTTPException as error:print(json.dumps({'status':error.status_code,'body':{'detail':error.detail}}))
 asyncio.run(call());raise SystemExit(0)
helper=Path.cwd()/'scripts/runtime/inotify_limitd.py'
spec=importlib.util.spec_from_file_location('isolated_limitd',helper);limitd=importlib.util.module_from_spec(spec)
original_read=Path.read_text
def read_isolated(self,*args,**kwargs):
 if self==Path('/var/lib/gugu-inotify-limitd/last-expansion'):return ''
 return original_read(self,*args,**kwargs)
with patch.object(Path,'read_text',read_isolated):spec.loader.exec_module(limitd)
proc=root/'proc';process=proc/'123';(process/'fdinfo').mkdir(parents=True)
(process/'status').write_text(f'Name:\tsynthetic\nUid:\t{os.getuid()}\t{os.getuid()}\t{os.getuid()}\t{os.getuid()}\n')
(process/'fdinfo/7').write_text('inotify wd:1 ino:1 sdev:1\n')
sysctl=root/'max_user_watches';sysctl.write_text('65536\n');limitd.STATE_PATH=root/'last-expansion'
original_snapshot=limitd.snapshot;original_expand=limitd.expand
limitd.snapshot=lambda uid,hard,*args:original_snapshot(uid,hard,proc,sysctl)
limitd.expand=lambda uid,hard,automatic:original_expand(uid,hard,automatic=automatic,proc_root=proc,sysctl_path=sysctl)
server=limitd.Server(str(root/'helper.sock'),limitd.Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();print('ready',flush=True)
try:sys.stdin.read()
finally:server.shutdown();server.server_close();thread.join(2);(root/'helper.sock').unlink(missing_ok=True)
