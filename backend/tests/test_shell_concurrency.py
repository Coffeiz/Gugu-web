import asyncio

from agent.security.shell_policy import session_shell_lock


def test_same_session_shell_lock_serializes_operations():
    async def run():
        active = 0
        peak = 0

        async def task():
            nonlocal active, peak
            async with session_shell_lock(42):
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                active -= 1

        await asyncio.gather(task(), task())
        return peak

    assert asyncio.run(run()) == 1
