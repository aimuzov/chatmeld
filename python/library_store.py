import asyncio
import base64
import json

from pymax.session.models import SessionInfo


class StorageRpc:
    def __init__(self, emit):
        self.emit = emit
        self.pending = {}
        self.next_id = 0

    async def request(self, method, **params):
        self.next_id += 1
        request_id = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        self.emit({"event": "storage", "requestId": request_id, "method": method, **params})
        try:
            return await asyncio.wait_for(future, timeout=45)
        finally:
            self.pending.pop(request_id, None)

    def respond(self, response):
        future = self.pending.get(response.get("requestId"))
        if future is None or future.done():
            return
        if "error" in response:
            future.set_exception(RuntimeError("MAX storage failed"))
        else:
            future.set_result(response.get("result"))

    def close(self):
        for future in self.pending.values():
            if not future.done():
                future.set_exception(RuntimeError("MAX storage closed"))


class RpcStore:
    key = "max/session/v1"

    def __init__(self, rpc):
        self.rpc = rpc
        self.lock = asyncio.Lock()

    async def save_session(self, session_info):
        async with self.lock:
            await self._save(session_info)

    async def _save(self, session_info):
        value = json.dumps({"version": 1, "session": session_info.model_dump(mode="json")}).encode()
        await self.rpc.request("writeBatch", changes=[{
            "type": "set", "key": self.key, "value": base64.b64encode(value).decode(),
        }])

    async def load_session(self):
        value = await self.rpc.request("read", key=self.key)
        if value is None:
            return None
        try:
            data = json.loads(base64.b64decode(value, validate=True))
            if data["version"] != 1:
                raise ValueError()
            return SessionInfo.model_validate(data["session"])
        except Exception:
            raise RuntimeError("Invalid MAX session") from None

    async def update_token(self, old_token, new_token, /):
        async with self.lock:
            session = await self.load_session()
            if session is not None and session.token == old_token:
                await self._save(session.model_copy(update={"token": new_token}))

    async def load_session_by_device_id(self, device_id):
        session = await self.load_session()
        return session if session is not None and session.device_id == device_id else None

    async def load_session_by_phone(self, phone):
        session = await self.load_session()
        return session if session is not None and session.phone == phone else None

    async def delete_session(self, token, /):
        async with self.lock:
            session = await self.load_session()
            if session is not None and session.token == token:
                await self.rpc.request("writeBatch", changes=[{"type": "delete", "key": self.key}])

    async def close(self):
        pass
