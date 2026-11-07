import unittest

from pymax.types.domain.chat import Chat
from pymax.types.domain.user import User
from chats import list_named_chats


def dialog(chat_id, **fields):
    return Chat.model_validate({
        "id": chat_id, "type": "DIALOG", "status": "ACTIVE", "owner": 1, **fields,
    })


class Contacts:
    def __init__(self, users, own_id=7):
        self.users = users
        self.me = type("Profile", (), {"contact": User(id=own_id)})()
        self.requested = []

    async def get_users(self, ids):
        self.requested.extend(ids)
        return [user for user in self.users if user.id in ids]


class ChatTests(unittest.IsolatedAsyncioTestCase):
    async def test_dialog_name_from_participant_profile(self):
        client = Contacts([User.model_validate({
            "id": 42, "names": [{"firstName": "Иван", "lastName": "Иванов"}],
        })])
        result = await list_named_chats(client, [dialog(45, participants={7: 0, 42: 0})])
        self.assertEqual(result, [{"id": "45", "title": "Иван Иванов"}])
        self.assertEqual(client.requested, [42])

    async def test_dialog_without_participants_resolves_xor_id(self):
        client = Contacts([User(id=42, names=[{"name": "Иван Иванов"}])])
        result = await list_named_chats(client, [dialog(45)])
        self.assertEqual(result[0]["title"], "Иван Иванов")
        self.assertEqual(client.requested, [42])

    async def test_group_title_is_preserved_without_contact_lookup(self):
        client = Contacts([])
        chat = dialog(100, type="CHAT", title="Рабочая группа")
        self.assertEqual(await list_named_chats(client, [chat]), [{"id": "100", "title": "Рабочая группа"}])
        self.assertEqual(client.requested, [])

    async def test_unknown_contact_still_has_a_usable_chat_id(self):
        client = Contacts([])
        self.assertEqual(await list_named_chats(client, [dialog(45)]), [{"id": "45", "title": "45"}])

    async def test_only_direct_bot_chat_is_classified(self):
        client = Contacts([])
        direct = dialog(45, title="Bot", hasBots=True)
        group = dialog(100, type="CHAT", title="Group", hasBots=True)
        self.assertEqual(await list_named_chats(client, [direct, group]), [
            {"id": "45", "title": "Bot", "isBot": True},
            {"id": "100", "title": "Group"},
        ])
