"""JSONL worker: stdout is protocol only; SDK output is redirected to stderr."""

import asyncio
import json
import logging
import signal
import sys

from instagram_runtime import BridgeError, InstagramRuntime, create_client, safe_error

OUTPUT = sys.stdout


def emit(value):
    print(json.dumps(value, ensure_ascii=False), file=OUTPUT, flush=True)


class EventRpc:
    def __init__(self, output):
        self.output = output
        self.sequence = 0
        self.pending = {}
        self.closed = False

    async def request(self, event, timeout):
        code = 'STORAGE_ERROR' if event['event'] == 'session' else 'AUTH_REQUIRED'
        if self.closed:
            raise BridgeError(code)
        self.sequence += 1
        request_id = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = (future, code)
        try:
            self.output({**event, 'requestId': request_id})
            return await asyncio.wait_for(future, timeout)
        except (TimeoutError, asyncio.CancelledError):
            raise BridgeError(code) from None
        finally:
            self.pending.pop(request_id, None)

    def respond(self, response):
        item = self.pending.get(response.get('requestId'))
        if item is None:
            return
        future, code = item
        if future.done():
            return
        if 'error' in response:
            future.set_exception(BridgeError(code))
        else:
            future.set_result(response.get('result'))

    def close(self):
        self.closed = True
        for future, code in self.pending.values():
            if not future.done():
                future.set_exception(BridgeError(code))


async def main(client_factory=None):
    if client_factory is None:
        client_factory = create_client
    rpc = EventRpc(emit)
    runtime = InstagramRuntime(client_factory, rpc.request, emit)
    reader = asyncio.StreamReader(limit=32 * 1024 * 1024)
    loop = asyncio.get_running_loop()
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    queue = asyncio.Queue(maxsize=32)
    main_task = asyncio.current_task()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, main_task.cancel)

    async def commands():
        while True:
            request = await queue.get()
            try:
                result = await runtime.command(request['method'], request.get('params', {}))
                emit({'id': request['id'], 'result': result})
            except Exception as error:
                failure = safe_error(error)
                emit({'id': request['id'], 'error': str(failure), 'code': failure.code})
                if failure.code == 'STORAGE_ERROR':
                    emit({'event': 'fatal', 'code': failure.code})
            finally:
                queue.task_done()

    consumer = asyncio.create_task(commands())
    try:
        while line := await reader.readline():
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError()
                if request.get('method') == 'eventResult':
                    rpc.respond(request)
                    continue
                if not isinstance(request.get('id'), int) or not isinstance(request.get('method'), str):
                    raise ValueError()
                queue.put_nowait(request)
            except (ValueError, asyncio.QueueFull):
                emit({'event': 'fatal', 'code': 'PROVIDER_ERROR'})
                break
    finally:
        transport.close()
        rpc.close()
        consumer.cancel()
        await asyncio.gather(consumer, return_exceptions=True)
        await runtime.close()


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    sys.stdout = sys.stderr
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except Exception:
        emit({'event': 'fatal', 'code': 'PROVIDER_ERROR'})
        sys.exit(1)
