import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { writeMessage } from "../src/core/output.js";

test("shutdown cancels waiting for a pipe whose consumer stopped reading", async () => {
  const output = new Writable({ highWaterMark: 1, write() {} });
  const stop = new AbortController();
  try {
    const writing = writeMessage(output, { text: "Привет" }, stop.signal);
    stop.abort();
    assert.equal(
      await Promise.race([writing.then(() => "stopped"), delay(100, "hung")]),
      "stopped",
    );
  } finally {
    output.destroy();
  }
});
