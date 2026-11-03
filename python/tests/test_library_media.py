import base64
import json
import select
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from pymax import Photo, Video, File, Message
from library_bridge import Bridge, UnsupportedOperation
from library_store import StorageRpc
from normalize import normalize_message


class MediaTests(unittest.IsolatedAsyncioTestCase):
    def test_worker_accepts_requests_larger_than_one_megabyte_without_files(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = subprocess.Popen(
                [sys.executable, "-B", "-u", str(Path(__file__).resolve().parents[1] / "library_bridge.py")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=directory,
            )
            try:
                worker.stdin.write((json.dumps({"id": 1, "method": "ping", "params": {"padding": "A" * 2_000_000}}) + "\n").encode())
                worker.stdin.flush()
                self.assertTrue(select.select([worker.stdout], [], [], 5)[0])
                self.assertEqual(json.loads(worker.stdout.readline()), {"id": 1, "result": {"ok": True}})
                worker.stdin.close()
                worker.wait(timeout=5)
                self.assertEqual(worker.returncode, 0)
                self.assertEqual(worker.stderr.read(), b"")
                self.assertEqual(list(Path(directory).iterdir()), [])
            finally:
                if worker.poll() is None:
                    worker.kill()
                    worker.wait(timeout=5)
                for stream in (worker.stdin, worker.stdout, worker.stderr):
                    stream.close()

    def bridge(self):
        bridge = Bridge(StorageRpc(lambda event: None), lambda event: None)
        bridge.client = SimpleNamespace(is_connected=True, get_chat=AsyncMock(),
            send_message=AsyncMock(return_value=SimpleNamespace(id=9007199254740993)),
            get_message=AsyncMock(), get_video_by_id=AsyncMock(), get_file_by_id=AsyncMock())
        return bridge

    async def test_upload_bytes_and_caption_for_photo_video_audio(self):
        for kind, model, mime, name in (("photo", Photo, "image/jpeg", "photo.jpg"),
                ("video", Video, "video/mp4", "clip.mp4"), ("audio", File, "audio/mpeg", "song.mp3")):
            with self.subTest(kind=kind):
                bridge = self.bridge()
                result = await bridge.command("sendMedia", {"chatId": "-42", "media": {
                    "kind": kind, "data": base64.b64encode(b"media bytes").decode(),
                    "mimeType": mime, "fileName": name, "caption": "caption"}})
                self.assertEqual(result, {"externalId": "-42:9007199254740993"})
                call = bridge.client.send_message.call_args.kwargs
                self.assertEqual(call["chat_id"], -42)
                self.assertEqual(call["text"], "caption")
                attachment = call["attachments"][0]
                self.assertIsInstance(attachment, model)
                self.assertEqual(await attachment.read(), b"media bytes")
                self.assertIsNone(attachment.path)

    async def test_invalid_and_oversized_base64_rejected_before_decode_or_send(self):
        for data in ("!bad!", "", "A" * (4 * ((20 * 1024 * 1024 + 2) // 3) + 4)):
            bridge = self.bridge()
            with patch("base64.b64decode", wraps=base64.b64decode) as decode:
                with self.assertRaises(ValueError):
                    await bridge.command("sendMedia", {"chatId": "1", "media": {
                        "kind": "photo", "data": data, "mimeType": "image/jpeg", "fileName": "photo.jpg"}})
                bridge.client.send_message.assert_not_called()
                if len(data) > 100:
                    decode.assert_not_called()

    async def test_unsupported_photo_formats_fail_before_sdk_and_keep_client_usable(self):
        for mime, name in (("image/avif", "photo.avif"), ("image/avif", "photo.jpg"),
                ("image/jpeg", "photo.avif"), ("image/png", "photo.tiff"),
                ("image/png", "photo"), ("image/svg+xml", "photo.png")):
            with self.subTest(mime=mime, name=name):
                bridge = self.bridge()
                params = {"chatId": "-42", "media": {"kind": "photo",
                    "data": base64.b64encode(b"bytes").decode(), "mimeType": mime, "fileName": name}}
                with self.assertRaises(UnsupportedOperation):
                    await bridge.command("sendMedia", params)
                bridge.client.get_chat.assert_not_called()
                bridge.client.send_message.assert_not_called()
                params["media"].update(mimeType="image/jpeg", fileName="photo.JPG")
                self.assertEqual(await bridge.command("sendMedia", params),
                    {"externalId": "-42:9007199254740993"})

    async def test_sdk_video_and_audio_file_have_no_extension_whitelist(self):
        for kind, mime, name in (("video", "video/webm", "clip.webm"),
                ("video", "video/mp4", "clip.custom"), ("audio", "audio/flac", "audio.flac"),
                ("audio", "audio/ogg", "recording.custom")):
            with self.subTest(kind=kind, name=name):
                bridge = self.bridge()
                await bridge.command("sendMedia", {"chatId": "-42", "media": {"kind": kind,
                    "data": base64.b64encode(b"bytes").decode(), "mimeType": mime, "fileName": name}})
                bridge.client.send_message.assert_awaited_once()

    async def test_resolves_current_message_photo_audio_video_file_urls(self):
        for item, expected, mime in ((SimpleNamespace(type="PHOTO", base_url="https://i.oneme.ru/p"), "https://i.oneme.ru/p", "image/jpeg"),
                (SimpleNamespace(type="AUDIO", url="https://audio.okcdn.ru/a"), "https://audio.okcdn.ru/a", "audio/ogg"),
                (SimpleNamespace(type="VIDEO", video_id=73), "https://video.okcdn.ru/v", "video/mp4"),
                (SimpleNamespace(type="FILE", file_id=74, name="song.mp3"), "https://files.oneme.ru/f", "audio/mpeg")):
            with self.subTest(kind=item.type):
                bridge = self.bridge()
                bridge.client.get_message.return_value = SimpleNamespace(attaches=[item])
                bridge.client.get_video_by_id.return_value = SimpleNamespace(url="https://video.okcdn.ru/v", external=False)
                bridge.client.get_file_by_id.return_value = SimpleNamespace(url="https://files.oneme.ru/f")
                result = await bridge.command("downloadMedia", {"payload": {"chatId": "-42", "messageId": "9007199254740993", "index": 0}})
                self.assertEqual(result["url"], expected)
                self.assertEqual(result["mimeType"], mime)
                bridge.client.get_message.assert_awaited_once_with(-42, 9007199254740993)
                if item.type == "VIDEO":
                    bridge.client.get_video_by_id.assert_awaited_once_with(-42, 9007199254740993, 73)

    async def test_missing_or_external_media_is_explicitly_unsupported(self):
        for item in (SimpleNamespace(type="AUDIO", url=None), SimpleNamespace(type="VIDEO", video_id=1), SimpleNamespace(type="STICKER")):
            bridge = self.bridge()
            bridge.client.get_message.return_value = SimpleNamespace(attaches=[item])
            bridge.client.get_video_by_id.return_value = SimpleNamespace(url=None, external="https://external.invalid/player")
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                await bridge.command("downloadMedia", {"payload": {"chatId": "1", "messageId": "2", "index": 0}})

    def test_normalization_adds_string_reference_payload_without_raw_urls(self):
        message = Message.model_validate({"id": 9007199254740993, "chatId": -42, "sender": 73,
            "text": "", "time": 1700000000000, "type": "USER",
            "attaches": [{"_type": "AUDIO", "url": "https://audio.okcdn.ru/secret"}]})
        result = normalize_message(message, "personal", 74)
        self.assertEqual(result["attachments"], [{"kind": "audio", "referencePayload": {
            "chatId": "-42", "messageId": "9007199254740993", "index": 0}}])
