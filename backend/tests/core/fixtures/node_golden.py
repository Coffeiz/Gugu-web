"""Node 自动差分测试的 Python 参考进程；仅接受测试构造的数据与临时文件。"""
from dataclasses import asdict
from pathlib import Path
import asyncio
import json
import sys

from gugu_core.domain.projects import normalize_project_stages, prepare_project_create, replace_project_stages
from gugu_core.domain.clients import prepare_client_fields
from gugu_core.data.runtime import LocalRuntime


async def main(request):
    action = request['action']
    if action == 'domain':
        results = []
        for case in request['cases']:
            try:
                if case['method'] == 'normalize':
                    value = normalize_project_stages(case['input'])
                elif case['method'] == 'create':
                    value = prepare_project_create(case['input'])
                elif case['method'] == 'client':
                    value = prepare_client_fields(case['input'], creating=True)
                else:
                    value = replace_project_stages(case['old'], case.get('current'), case['input'])
                results.append({'result': value})
            except (ValueError, TypeError, KeyError):
                results.append({'error': 'invalid_request'})
        return results
    path = Path(request['database'])
    runtime = await (LocalRuntime.initialize(path) if action == 'initialize' else LocalRuntime.open(path))
    try:
        if action == 'initialize':
            async with runtime.unit_of_work() as data:
                await data.projects.create({'name': 'Python 原有计划'})
                await data.clients.create({'name': '小北'})
        async with runtime.unit_of_work() as data:
            return {'owner': str(runtime.owner_id), 'projects': [asdict(row) for row in await data.projects.list()], 'clients': [asdict(row) for row in await data.clients.list()]}
    finally:
        await runtime.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(asyncio.run(main(json.load(sys.stdin))), ensure_ascii=False, default=str))
