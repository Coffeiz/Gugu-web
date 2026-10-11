import asyncio

from agent.tools.base import parallel_dispatch_context
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


def test_parallel_round_shell_calls_do_not_reacquire_the_same_session_lock():
    async def run():
        active = 0
        peak = 0
        barrier = asyncio.Event()
        started = 0

        async def task():
            nonlocal active, peak, started
            with parallel_dispatch_context():
                async with session_shell_lock(42):
                    active += 1
                    peak = max(peak, active)
                    started += 1
                    if started == 2:
                        barrier.set()
                    await asyncio.wait_for(barrier.wait(), timeout=1)
                    active -= 1

        await asyncio.gather(task(), task())
        return peak

    assert asyncio.run(run()) == 2
