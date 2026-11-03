import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonProcess } from "../src/core/json-process.js";

function worker(events: Record<string, unknown>[] = []) {
  return new JsonProcess(
    process.execPath,
    ["test/fixtures/rpc-worker.mjs"],
    (event) => events.push(event),
    () => undefined,
  );
}

test("routes responses to matching requests even when replies arrive out of order", async () => {
  const rpc = worker();
  try {
    const first = rpc.request("echo", { value: "first", delay: 20 });
    const second = rpc.request("echo", { value: "second" });
    assert.deepEqual(await second, { value: "second" });
    assert.deepEqual(await first, { value: "first", delay: 20 });
  } finally {
    await rpc.close();
  }
});

test("delivers events separately from RPC responses and preserves server errors", async () => {
  const events: Record<string, unknown>[] = [];
  const rpc = worker(events);
  try {
    await rpc.request("event", {});
    assert.deepEqual(events, [{ event: "message", text: "Привет" }]);
    await assert.rejects(rpc.request("error"), /session expired/);
  } finally {
    await rpc.close();
  }
});

test("rejects waiting requests when the worker exits", async () => {
  const rpc = worker();
  try {
    await assert.rejects(rpc.request("exit"), /код 3/);
  } finally {
    await rpc.close();
  }
});

test("times out a stalled worker instead of waiting forever", async () => {
  const rpc = worker();
  try {
    await assert.rejects(rpc.request("hang", {}, 50), /время ожидания/);
  } finally {
    await rpc.close();
  }
});
