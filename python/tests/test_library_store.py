import asyncio
import base64
import unittest

from pymax.session.models import SessionInfo
from pymax import ExtraConfig
from library_store import RpcStore, StorageRpc


class StoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_write_waits_for_ack_and_roundtrips_session(self):
        events = []
        rpc = StorageRpc(events.append)
        store = RpcStore(rpc)
        info = SessionInfo(
            token="secret", device_id="device", phone="", mt_instance_id="instance",
            user_agent=ExtraConfig().generate_web_user_agent(),
            sync={"chats_sync": 9223372036854775806, "contacts_sync": 123, "config_hash": "custom"},
        )
        pending = asyncio.create_task(store.save_session(info))
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        event = events.pop()
        value = event["changes"][0]["value"]
        rpc.respond({"requestId": event["requestId"], "result": None})
        await pending
        loaded = asyncio.create_task(store.load_session())
        await asyncio.sleep(0)
        rpc.respond({"requestId": events.pop()["requestId"], "result": value})
        self.assertEqual(await loaded, info)
        self.assertEqual(info.model_dump(), (await self.roundtrip(store, rpc, events, value)).model_dump())

    async def roundtrip(self, store, rpc, events, value):
        pending = asyncio.create_task(store.load_session_by_device_id("device"))
        await asyncio.sleep(0)
        rpc.respond({"requestId": events.pop()["requestId"], "result": value})
        return await pending

    async def test_storage_failure_is_safe_and_not_missing_session(self):
        events = []
        rpc = StorageRpc(events.append)
        pending = asyncio.create_task(RpcStore(rpc).load_session())
        await asyncio.sleep(0)
        rpc.respond({"requestId": events.pop()["requestId"], "error": "database secret"})
        with self.assertRaisesRegex(RuntimeError, "MAX storage failed") as raised:
            await pending
        self.assertNotIn("secret", str(raised.exception))

    async def test_corrupt_session_does_not_become_new_login(self):
        events = []
        rpc = StorageRpc(events.append)
        pending = asyncio.create_task(RpcStore(rpc).load_session())
        await asyncio.sleep(0)
        rpc.respond({"requestId": events.pop()["requestId"], "result": base64.b64encode(b'{}').decode()})
        with self.assertRaisesRegex(RuntimeError, "Invalid MAX session"):
            await pending

    async def test_token_rotation_and_delete_wait_for_durable_storage(self):
        values = {}
        writes = []

        class MemoryRpc:
            async def request(self, method, **params):
                if method == "read":
                    return values.get(params["key"])
                writes.append(params["changes"])
                for change in params["changes"]:
                    if change["type"] == "delete":
                        values.pop(change["key"], None)
                    else:
                        values[change["key"]] = change["value"]

        store = RpcStore(MemoryRpc())
        await store.save_session(SessionInfo(token="old", device_id="device", phone="123", sync={"chats_sync": 999}))
        await store.update_token("wrong", "ignored")
        self.assertEqual(len(writes), 1)
        await store.update_token("old", "new")
        self.assertEqual((await store.load_session_by_phone("123")).token, "new")
        self.assertEqual((await store.load_session()).sync.chats_sync, 999)
        self.assertIsNone(await store.load_session_by_device_id("other"))
        await store.delete_session("old")
        self.assertIsNotNone(await store.load_session())
        await store.delete_session("new")
        self.assertIsNone(await store.load_session())
