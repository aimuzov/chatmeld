import asyncio
import json
import select
import subprocess
import sys
import unittest
from pathlib import Path

from bridge import SessionRequired


class BridgeTests(unittest.TestCase):
    def test_missing_session_does_not_start_implicit_qr_login(self):
        with self.assertRaisesRegex(RuntimeError, "login --provider=max --qr"):
            asyncio.run(SessionRequired().authenticate(None))

    def test_real_python_worker_answers_ping_without_max_credentials(self):
        worker = subprocess.Popen(
            [sys.executable, "-u", str(Path(__file__).resolve().parents[1] / "bridge.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            worker.stdin.write(b'{"id":1,"method":"ping"}\n')
            worker.stdin.flush()
            self.assertTrue(select.select([worker.stdout], [], [], 5)[0])
            result = worker.stdout.readline()
            self.assertEqual(json.loads(result), {"id": 1, "result": {"ok": True}})
            worker.stdin.close()
            worker.wait(timeout=5)
            self.assertEqual(worker.returncode, 0)
        finally:
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=5)
            for stream in (worker.stdin, worker.stdout, worker.stderr):
                stream.close()
