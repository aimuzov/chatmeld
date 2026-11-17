import unittest

from pymax import Message
from normalize import normalize_message


class NormalizeTests(unittest.TestCase):
    def test_real_pymax_message_preserves_large_ids_and_milliseconds(self):
        message = Message.model_validate({
            "id": 9007199254740993, "chatId": -42, "sender": 73,
            "text": "Привет", "time": 1700000000000, "type": "USER",
        })
        result = normalize_message(message, "personal", 74)
        self.assertEqual(result["provider"], "max")
        self.assertEqual(result["accountId"], "personal")
        self.assertEqual(result["messageId"], "-42:9007199254740993")
        self.assertEqual(result["senderId"], "73")
        self.assertEqual(result["sentAt"], "2023-11-14T22:13:20.000Z")
        self.assertEqual(result["text"], "Привет")
        self.assertEqual(result["direction"], "incoming")

    def test_own_realtime_messages_match_history_identity_and_direction(self):
        message = Message.model_validate({
            "id": 1, "chatId": 42, "sender": 73,
            "text": "Привет", "time": 1700000000000, "type": "USER",
        })
        realtime = normalize_message(message, "personal", 73)
        history = normalize_message(message, "personal", 73, history_chat_id=42)
        self.assertEqual(realtime, history)
        self.assertEqual(realtime["direction"], "outgoing")
        self.assertEqual(realtime["messageId"], "42:1")
        self.assertEqual(realtime["text"], "Привет")

    def test_messages_without_chat_are_not_forwarded(self):
        message = Message.model_validate({
            "id": 1, "sender": 73, "text": "Привет",
            "time": 1700000000000, "type": "USER",
        })
        self.assertIsNone(normalize_message(message, "personal", 73))
        message.chat_id = None
        self.assertIsNone(normalize_message(message, "personal", 74))

    def test_media_only_message_keeps_attachment_type(self):
        message = Message.model_validate({
            "id": 1, "chatId": 42, "sender": 73,
            "text": "", "time": 1700000000000, "type": "USER",
            "attaches": [{"_type": "FUTURE_ATTACHMENT", "custom": "value"}],
        })
        result = normalize_message(message, "personal", 74)
        self.assertEqual(result["attachments"], [{"kind": "FUTURE_ATTACHMENT"}])


if __name__ == "__main__":
    unittest.main()
