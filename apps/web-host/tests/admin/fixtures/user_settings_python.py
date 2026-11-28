import pytest
from types import SimpleNamespace
from fastapi import HTTPException
pytest_plugins = ['tests.conftest']

@pytest.mark.asyncio
async def test_quota_and_developer(db, user_a, monkeypatch):
    from app.api.v1 import users_admin as module
    calls=[]
    async def audit(*args): calls.append(args)
    monkeypatch.setattr(module,'write_log',audit)
    request=SimpleNamespace(state=SimpleNamespace(admin_username='测试管理员'))
    result=await module.update_quota(user_a.id,{'token_limit_6h':' -1 ','token_limit_weekly':4.9,'search_limit_daily':True},request,db)
    assert result['token_limit_6h']==-1 and result['token_limit_weekly']==4 and result['search_limit_daily']==1
    result=await module.update_quota(user_a.id,{'search_limit_daily':'１２_３'},request,db)
    assert result['search_limit_daily']==123
    for bad in [{'search_limit_daily':-1},{'token_limit_6h':'2.5'},{'token_limit_6h':[]}]:
        with pytest.raises(HTTPException) as error: await module.update_quota(user_a.id,bad,request,db)
        assert error.value.status_code==422
    for expected in [True,False]:
        result=await module.toggle_developer(user_a.id,request,db)
        assert result['is_developer'] is expected
