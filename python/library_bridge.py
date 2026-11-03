import asyncio
import json
import logging
import signal
import sys

from pymax import ExtraConfig, QrAuthFlow, WebClient
from chats import list_named_chats
from normalize import normalize_message
from library_store import RpcStore, StorageRpc

OUTPUT = sys.stdout


def emit(value):
    print(json.dumps(value, ensure_ascii=False), file=OUTPUT, flush=True)


class AuthorizationRequired(RuntimeError):
    pass


class SessionRequired:
    async def authenticate(self, app):
        raise AuthorizationRequired("MAX authorization required")


class Bridge:
    def __init__(self, rpc, output):
        self.store = RpcStore(rpc)
        self.emit = output
        self.client = None
        self.account_id = ""
        self.password = None
        self.closing = False
        self.listening = False
        self.monitor = None

    async def show_qr(self, qr_url):
        self.emit({"event": "qr", "url": qr_url})

    async def get_password(self, hint=None):
        self.password = asyncio.get_running_loop().create_future()
        self.emit({"event": "password"})
        try:
            return await self.password
        finally:
            self.password = None

    async def ensure_connected(self, params, allow_auth):
        if self.client is not None:
            if not self.client.is_connected:
                raise RuntimeError("MAX disconnected")
            return
        self.account_id = params["accountId"]
        if not allow_auth and await self.store.load_session() is None:
            raise AuthorizationRequired("MAX authorization required")
        self.client = WebClient(
            auth_flow=QrAuthFlow(self, password_provider=self) if allow_auth else SessionRequired(),
            extra_config=ExtraConfig(
                store=self.store, persist_session=True,
                log_level="CRITICAL", reconnect=False, relogin=False,
                telemetry=False, request_timeout=30, password_max_attempts=3,
            ),
        )

        @self.client.on_message()
        async def incoming(message, client):
            if not self.listening or client.me is None:
                return
            try:
                result = normalize_message(message, self.account_id, client.me.contact.id)
                if result is not None:
                    self.emit({"event": "message", "message": result})
            except Exception:
                self.emit({"event": "fatal"})

        @self.client.on_disconnect()
        async def disconnected(*args, **kwargs):
            if not self.closing:
                self.emit({"event": "fatal"})

        self.listening = True
        await self.client.connect()
        if self.client.me is None:
            raise RuntimeError("MAX profile unavailable")
        self.monitor = asyncio.create_task(self.watch_connection())

    async def watch_connection(self):
        while not self.closing:
            await asyncio.sleep(1)
            if not self.client.is_connected:
                self.emit({"event": "fatal"})
                return

    async def command(self, method, params):
        if method == "ping":
            return {"ok": True}
        if method in ("login", "connect"):
            await self.ensure_connected(params, allow_auth=method == "login")
            return {"ok": True}
        if self.client is None or not self.client.is_connected:
            raise RuntimeError("MAX disconnected")
        if method == "chats":
            chats = {chat.id: chat for chat in self.client.chats or []}
            for chat in await self.client.fetch_chats():
                chats[chat.id] = chat
            return await list_named_chats(self.client, list(chats.values()))
        if method == "send":
            chat_id = int(params["chatId"])
            await self.client.get_chat(chat_id)
            message = await self.client.send_message(chat_id=chat_id, text=params["text"])
            return {"externalId": f"{chat_id}:{message.id}"}
        raise RuntimeError("Unknown MAX method")

    async def close(self):
        self.closing = True
        if self.monitor is not None:
            self.monitor.cancel()
            await asyncio.gather(self.monitor, return_exceptions=True)
        if self.client is not None:
            await self.client.close()


async def main():
    rpc = StorageRpc(emit)
    bridge = Bridge(rpc, emit)
    lock = asyncio.Lock()
    tasks = set()
    reader = asyncio.StreamReader(limit=1_048_576)
    loop = asyncio.get_running_loop()
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    main_task = asyncio.current_task()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, main_task.cancel)

    async def handle(request):
        try:
            async with lock:
                result = await bridge.command(request["method"], request.get("params", {}))
            emit({"id": request["id"], "result": result})
        except AuthorizationRequired:
            emit({"id": request["id"], "error": "MAX authorization required", "code": "AUTH_REQUIRED"})
        except Exception:
            emit({"id": request["id"], "error": "MAX request failed"})

    try:
        while line := await reader.readline():
            request = json.loads(line)
            if request.get("method") == "storageResult":
                rpc.respond(request)
                continue
            if request.get("method") == "password":
                if bridge.password is not None and not bridge.password.done():
                    bridge.password.set_result(request["value"])
                continue
            if len(tasks) >= 100:
                raise RuntimeError("MAX request queue exceeded")
            task = asyncio.create_task(handle(request))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        transport.close()
        rpc.close()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await bridge.close()


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        from loguru import logger
        logger.remove()
        logger.disable("pymax")
    except ImportError:
        pass
    sys.stdout = sys.stderr
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except Exception:
        emit({"event": "fatal"})
        sys.exit(1)
