import asyncio
import base64
import json
import logging
import mimetypes
import re
import signal
import sys
from datetime import datetime, timezone

from pymax import ExtraConfig, QrAuthFlow, WebClient, Photo, Video, File
from chats import list_named_chats
from normalize import normalize_message, normalize_read_receipt
from library_store import RpcStore, StorageRpc

OUTPUT = sys.stdout
MAX_MEDIA_BYTES = 20 * 1024 * 1024
MAX_REQUEST_BYTES = 32 * 1024 * 1024


def emit(value):
    print(json.dumps(value, ensure_ascii=False), file=OUTPUT, flush=True)


class AuthorizationRequired(RuntimeError):
    pass


class UnsupportedOperation(RuntimeError):
    pass


def decode_media(media):
    encoded = media.get("data")
    if not isinstance(encoded, str) or not encoded or len(encoded) > 4 * ((MAX_MEDIA_BYTES + 2) // 3):
        raise ValueError("Invalid MAX media")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        raise ValueError("Invalid MAX media") from None
    if not data or len(data) > MAX_MEDIA_BYTES:
        raise ValueError("Invalid MAX media")
    return data


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

        @self.client.on_message_read()
        async def read(event, client):
            if not self.listening or self.closing or client.me is None:
                return
            chat = next((chat for chat in client.chats or [] if chat.id == event.chat_id), None)
            receipt = normalize_read_receipt(event, self.account_id, client.me.contact.id, chat is not None and chat.type == "DIALOG")
            if receipt is not None:
                self.emit({"event": "receipt", "receipt": receipt})

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
        if method == "avatar":
            target_id = int(params["id"])
            if params["type"] == "user":
                users = await self.client.get_users([target_id])
                return next((user.base_url for user in users if user.id == target_id), None)
            if params["type"] != "chat":
                raise ValueError("Invalid MAX avatar target")
            chat = await self.client.get_chat(target_id)
            if chat.base_icon_url:
                return chat.base_icon_url
            if chat.type != "DIALOG":
                return None
            own_id = self.client.me.contact.id
            peers = [user_id for user_id in chat.participants if user_id != own_id]
            peer_id = peers[0] if len(peers) == 1 else chat.id ^ own_id
            users = await self.client.get_users([peer_id])
            return next((user.base_url for user in users if user.id == peer_id), None)
        if method == "sendMedia":
            media = params["media"]
            models = {"photo": Photo, "video": Video, "audio": File}
            if media.get("kind") not in models:
                raise UnsupportedOperation("MAX media unavailable")
            data = decode_media(media)
            name = media["fileName"]
            if not isinstance(name, str) or not name or len(name) > 255 or "/" in name or "\\" in name:
                raise ValueError("Invalid MAX media filename")
            mime = media.get("mimeType", "").split(";", 1)[0].strip().lower()
            if media["kind"] == "photo":
                if mime not in {"image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/bmp", "image/x-ms-bmp"}:
                    raise UnsupportedOperation("MAX media unavailable")
            elif not mime.startswith(f"{media['kind']}/"):
                raise UnsupportedOperation("MAX media unavailable")
            attachment = models[media["kind"]](raw=data, name=name)
            if media["kind"] == "photo":
                try:
                    attachment.validate_photo()
                except ValueError:
                    raise UnsupportedOperation("MAX media unavailable") from None
            chat_id = int(params["chatId"])
            await self.client.get_chat(chat_id)
            message = await self.client.send_message(chat_id=chat_id, text=media.get("caption") or None,
                attachments=[attachment])
            return {"externalId": f"{chat_id}:{message.id}"}
        if method == "downloadMedia":
            payload = params["payload"]
            if not all(isinstance(payload.get(key), str) and re.fullmatch(r"-?\d{1,100}", payload[key])
                    for key in ("chatId", "messageId")):
                raise ValueError("Invalid MAX media reference")
            index = payload.get("index")
            if type(index) is not int or index < 0:
                raise ValueError("Invalid MAX media reference")
            chat_id, message_id = int(payload["chatId"]), int(payload["messageId"])
            message = await self.client.get_message(chat_id, message_id)
            if message is None or index >= len(message.attaches):
                raise UnsupportedOperation("MAX media unavailable")
            item = message.attaches[index]
            kind = item.type
            filename = None
            if kind == "PHOTO":
                url, mime = item.base_url, "image/jpeg"
            elif kind == "AUDIO":
                url, mime = item.url, "audio/ogg"
            elif kind == "VIDEO":
                video = await self.client.get_video_by_id(chat_id, message_id, item.video_id)
                url, mime = (video.url if video and not video.external else None), "video/mp4"
            elif kind == "FILE":
                file = await self.client.get_file_by_id(chat_id, message_id, item.file_id)
                url = file.url if file else None
                filename = item.name
                mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            else:
                raise UnsupportedOperation("MAX media unavailable")
            if not isinstance(url, str) or not url:
                raise UnsupportedOperation("MAX media unavailable")
            return {"url": url, "mimeType": mime, **({"fileName": filename} if filename else {})}
        if method == "send":
            chat_id = int(params["chatId"])
            await self.client.get_chat(chat_id)
            message = await self.client.send_message(chat_id=chat_id, text=params["text"])
            return {"externalId": f"{chat_id}:{message.id}", "sentAt": datetime.fromtimestamp(message.time / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
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
    reader = asyncio.StreamReader(limit=MAX_REQUEST_BYTES)
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
        except UnsupportedOperation:
            emit({"id": request["id"], "error": "MAX media unavailable", "code": "UNSUPPORTED_OPERATION"})
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
