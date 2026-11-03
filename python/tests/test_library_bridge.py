import unittest
import json
import select
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

from library_bridge import Bridge, SessionRequired
from library_store import StorageRpc


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def test_real_worker_missing_session_returns_auth_required_without_files(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = subprocess.Popen(
                [sys.executable, "-B", "-u", str(Path(__file__).resolve().parents[1] / "library_bridge.py")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=directory,
            )
            try:
                worker.stdin.write(b'{"id":1,"method":"ping"}\n')
                worker.stdin.flush()
                self.assertTrue(select.select([worker.stdout], [], [], 5)[0])
                self.assertEqual(json.loads(worker.stdout.readline()), {"id": 1, "result": {"ok": True}})
                worker.stdin.write(b'{"id":2,"method":"connect","params":{"accountId":"one"}}\n')
                worker.stdin.flush()
                self.assertTrue(select.select([worker.stdout], [], [], 5)[0])
                read = json.loads(worker.stdout.readline())
                self.assertEqual(read["event"], "storage")
                self.assertEqual(read["method"], "read")
                worker.stdin.write((json.dumps({"method": "storageResult", "requestId": read["requestId"], "result": None}) + "\n").encode())
                worker.stdin.flush()
                self.assertTrue(select.select([worker.stdout], [], [], 5)[0])
                self.assertEqual(json.loads(worker.stdout.readline()), {
                    "id": 2, "error": "MAX authorization required", "code": "AUTH_REQUIRED",
                })
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

    async def test_connect_uses_rpc_store_and_no_session_files(self):
        class Client:
            def __init__(self, **kwargs):
                self.config = kwargs
                self.me = object()
                self.is_connected = True
                self.connect = AsyncMock()
                self.close = AsyncMock()

            def on_message(self):
                return lambda fn: fn

            def on_disconnect(self):
                return lambda fn: fn

        bridge = Bridge(StorageRpc(lambda event: None), lambda event: None)
        bridge.store.load_session = AsyncMock(return_value=object())
        with patch("library_bridge.WebClient", Client):
            await bridge.command("connect", {"accountId": "one"})
            config = bridge.client.config
            self.assertIs(config["extra_config"].store, bridge.store)
            self.assertTrue(config["extra_config"].persist_session)
            self.assertNotIn("sessionFile", config)
            self.assertIsInstance(config["auth_flow"], SessionRequired)
            self.assertTrue(bridge.listening)
            await bridge.close()

    async def test_missing_session_fails_before_constructing_network_client(self):
        bridge = Bridge(StorageRpc(lambda event: None), lambda event: None)
        bridge.store.load_session = AsyncMock(return_value=None)
        with patch("library_bridge.WebClient") as client:
            with self.assertRaisesRegex(RuntimeError, "MAX authorization required"):
                await bridge.command("connect", {"accountId": "one"})
            client.assert_not_called()

    async def test_connect_without_session_does_not_request_qr(self):
        with self.assertRaisesRegex(RuntimeError, "MAX authorization required"):
            await SessionRequired().authenticate(None)
