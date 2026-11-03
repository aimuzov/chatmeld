import assert from "node:assert/strict";
import { test } from "node:test";
import { telegramLoginUrl } from "../src/providers/telegram/qr.js";

test("encodes login tokens with URL-safe base64 without padding", () => {
  assert.equal(
    telegramLoginUrl(Buffer.from([255, 254, 253, 252])),
    "tg://login?token=__79_A",
  );
});
