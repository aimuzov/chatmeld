import unittest
from types import SimpleNamespace
from normalize import normalize_read_receipt


class ReceiptTests(unittest.TestCase):
    def test_private_read_mark_uses_server_timestamp(self):
        event = SimpleNamespace(set_as_unread=False, chat_id=42, user_id=2, mark=1700000000000)
        self.assertEqual(normalize_read_receipt(event, "a", 1, True), {
            "provider": "max", "accountId": "a", "chatId": "42", "status": "read", "throughSentAt": "2023-11-14T22:13:20.000Z",
        })

    def test_own_marks_unread_marks_and_group_marks_are_ignored(self):
        for own, unread, direct in [(2, False, True), (1, True, True), (1, False, False)]:
            event = SimpleNamespace(set_as_unread=unread, chat_id=42, user_id=2, mark=1700000000000)
            self.assertIsNone(normalize_read_receipt(event, "a", own, direct))
