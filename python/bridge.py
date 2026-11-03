import asyncio
import json
import os
import signal
import sys
from pathlib import Path

from pymax import ExtraConfig, QrAuthFlow, WebClient
from normalize import normalize_message
from chats import list_named_chats

OUTPUT = sys.stdout


def emit(value):
    print(json.dumps(value, ensure_ascii=False), file=OUTPUT, flush=True)


class SessionRequired:
    async def authenticate(self, app):
        raise RuntimeError("Нет сессии MAX. Выполните npm start -- login --provider=max --qr.")


class Bridge:
    def __init__(self):
        self.client = None
        self.account_id = "personal"
        self.listening = False
        self.password = None
        self.closing = False
        self.monitor = None

    async def show_qr(self, qr_url):
        emit({"event": "qr", "url": qr_url})

    async def get_password(self, hint=None):
        self.password = asyncio.get_running_loop().create_future()
        emit({"event": "password"})
        try:
            return await self.password
        finally:
            self.password = None

    async def ensure_connected(self, params, allow_auth=False):
        if self.client is not None:
            if not self.client.is_connected:
                raise RuntimeError("Соединение MAX закрыто. Запустите команду заново.")
            return
        path = Path(params["sessionFile"]).resolve()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.account_id = params["accountId"]
        flow = QrAuthFlow(self, password_provider=self) if allow_auth else SessionRequired()
        self.client = WebClient(
            work_dir=str(path.parent), session_name=path.name, auth_flow=flow,
            extra_config=ExtraConfig(
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
                    emit({"event": "message", "message": result})
            except Exception as error:
                emit({"event": "fatal", "error": str(error)})

        @self.client.on_disconnect()
        async def disconnected(*args, **kwargs):
            if not self.closing:
                emit({"event": "fatal", "error": "Соединение MAX потеряно. Запустите команду заново."})

        await self.client.connect()
        if self.client.me is None:
            raise RuntimeError("MAX не вернул профиль после входа.")
        if path.exists():
            path.chmod(0o600)
        self.monitor = asyncio.create_task(self.watch_connection())

    async def watch_connection(self):
        while not self.closing:
            await asyncio.sleep(1)
            if not self.client.is_connected:
                emit({"event": "fatal", "error": "Соединение MAX потеряно. Запустите команду заново."})
                return

    async def command(self, method, params):
        if method == "ping":
            return {"ok": True}
        await self.ensure_connected(params, allow_auth=method == "login")
        if method in ("login", "authorize"):
            return {"ok": True}
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
        if method == "listen":
            self.listening = True
            return {"ok": True}
        if method == "unlisten":
            self.listening = False
            return {"ok": True}
        raise ValueError(f"Неизвестный метод: {method}")

    async def close(self):
        self.closing = True
        if self.monitor is not None:
            self.monitor.cancel()
            await asyncio.gather(self.monitor, return_exceptions=True)
        if self.client is not None:
            await self.client.close()


async def main():
    os.umask(0o077)
    bridge = Bridge()
    lock = asyncio.Lock()
    tasks = set()
    reader = asyncio.StreamReader()
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
        except Exception as error:
            emit({"id": request["id"], "error": str(error)})

    try:
        while line := await reader.readline():
            request = json.loads(line)
            if request.get("method") == "password":
                if bridge.password is not None and not bridge.password.done():
                    bridge.password.set_result(request["value"])
                continue
            task = asyncio.create_task(handle(request))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        transport.close()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await bridge.close()


if __name__ == "__main__":
    sys.stdout = sys.stderr
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
