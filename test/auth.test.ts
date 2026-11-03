import assert from "node:assert/strict";
import { test } from "node:test";
import { codeDeliveryHint } from "../src/providers/telegram/auth.js";

test("shows Telegram app delivery instead of suggesting SMS", () => {
  assert.match(
    codeDeliveryHint(true, { type: "app", length: 5 }),
    /служебном чате Telegram/,
  );
});

test("uses server delivery type over legacy viaApp flag", () => {
  assert.match(codeDeliveryHint(true, { type: "sms", length: 5 }), /SMS/);
  assert.doesNotMatch(
    codeDeliveryHint(true, { type: "sms" }),
    /служебном чате/,
  );
});

test("explains phone call code and missing delivery metadata", () => {
  assert.match(
    codeDeliveryHint(false, { type: "missedCall", prefix: "+123" }),
    /последние цифры/,
  );
  assert.match(codeDeliveryHint(), /не сообщил/);
});
