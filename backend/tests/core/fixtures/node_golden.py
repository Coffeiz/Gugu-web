"""Node 自动差分测试的 Python 参考进程；仅接受测试构造的数据与临时文件。"""
from dataclasses import asdict, is_dataclass
from pathlib import Path
import asyncio
import json
import sys

from gugu_core.domain.projects import normalize_project_stages, prepare_project_create, replace_project_stages
from gugu_core.domain.clients import prepare_client_fields
from gugu_core.data.runtime import LocalRuntime
from gugu_core.application.clients import ClientNotFound
from gugu_core.application.projects import ProjectConflict, ProjectNotFound


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
                    value = prepare_client_fields(case['input'], creating=case.get('creating', True))
                else:
                    value = replace_project_stages(case['old'], case.get('current'), case['input'])
                results.append({'result': value})
            except (ValueError, TypeError, KeyError):
                results.append({'error': 'invalid_request'})
        return results
    if action == 'services':
        runtime = await LocalRuntime.initialize(Path(request['database']))

        async def command(data, item):
            method = item['method']
            if method == 'clients.create':
                return await data.clients.create(item['fields'])
            if method == 'clients.update':
                return await data.clients.update(item['id'], item['fields'])
            if method == 'clients.delete':
                return await data.clients.delete(item['id'])
            if method == 'clients.list':
                return [asdict(row) for row in await data.clients.list()]
            if method == 'projects.create':
                return await data.projects.create(item['fields'])
            if method == 'projects.update':
                return await data.projects.update(item['id'], item['version'], item['fields'])
            if method == 'projects.list':
                return [asdict(row) for row in await data.projects.list(archived=item.get('archived', False))]
            raise ValueError('不支持的合成测试命令')

        results = []
        try:
            for item in request['sequence']:
                try:
                    async with runtime.unit_of_work() as data:
                        if 'batch' in item:
                            value = [await command(data, part) for part in item['batch']]
                        else:
                            value = await command(data, item)
                    results.append({'result': asdict(value) if is_dataclass(value) else value})
                except (ClientNotFound, ProjectNotFound):
                    results.append({'error': 'not_found'})
                except ProjectConflict:
                    results.append({'error': 'conflict'})
                except (ValueError, TypeError):
                    results.append({'error': 'invalid_request'})
            return results
        finally:
            await runtime.close()
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
