import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from library_bridge import Bridge
from library_store import StorageRpc
from pymax.types.domain.user import User
from pymax.types.domain.chat import Chat

class AvatarTests(unittest.IsolatedAsyncioTestCase):
    async def test_user_and_chat_avatars_use_real_sdk_models(self):
        bridge = Bridge(StorageRpc(lambda event: None), lambda event: None)
        user = User(id=42, base_url="https://i.oneme.ru/i?r=user", base_raw_url="https://i.oneme.ru/i?r=raw")
        chat = Chat(id=-7, type="CHAT", status="ACTIVE", owner=1, base_icon_url="https://i.oneme.ru/i?r=group")
        client = SimpleNamespace(is_connected=True, me=SimpleNamespace(contact=SimpleNamespace(id=1)), get_users=AsyncMock(return_value=[user]), get_chat=AsyncMock(return_value=chat))
        bridge.client=client
        self.assertEqual(await bridge.command("avatar", {"type":"user", "id":"42"}),user.base_url)
        client.get_users.assert_awaited_once_with([42])
        self.assertEqual(await bridge.command("avatar", {"type":"chat", "id":"-7"}),chat.base_icon_url)
        chat.base_icon_url=None
        self.assertIsNone(await bridge.command("avatar", {"type":"chat", "id":"-7"}))
        client.get_users.assert_awaited_once()

    async def test_dialog_resolves_peer_but_empty_group_does_not(self):
        bridge = Bridge(StorageRpc(lambda event: None), lambda event: None)
        chat = Chat(id=43, type="DIALOG", status="ACTIVE", owner=1, participants={1:0,42:0})
        user = User(id=42,base_url="https://i.oneme.ru/i?r=peer")
        bridge.client=SimpleNamespace(is_connected=True,me=SimpleNamespace(contact=SimpleNamespace(id=1)),get_chat=AsyncMock(return_value=chat),get_users=AsyncMock(return_value=[user]))
        self.assertEqual(await bridge.command("avatar",{"type":"chat","id":"43"}),user.base_url)
        user.base_url=None
        self.assertIsNone(await bridge.command("avatar",{"type":"user","id":"42"}))
