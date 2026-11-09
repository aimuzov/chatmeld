import assert from "node:assert/strict";
import { test } from "node:test";
import {
  tokenFromVkRequest,
  decodeVkQr,
} from "../src/providers/vk/qr-helpers.js";
import QRCode from "qrcode";
import { chromium, type Browser } from "playwright";
import { loginWithVkQr, restoreVkSession } from "../src/providers/vk/qr.js";

test("VK QR accepts tokens only from trusted VK API message requests", () => {
  const token = "vk1.a." + "a".repeat(64);
  assert.equal(
    tokenFromVkRequest(
      "https://api.vk.ru/method/messages.getConversations",
      `access_token=${token}`,
    ),
    token,
  );
  assert.equal(
    tokenFromVkRequest(
      `https://api.vk.com/method/execute?access_token=${token}`,
    ),
    token,
  );
  assert.equal(
    tokenFromVkRequest(
      "https://api.vk.ru/method/users.get",
      `access_token=${token}`,
    ),
    undefined,
  );
  assert.equal(
    tokenFromVkRequest(
      "https://api.vk.ru.evil.invalid/method/messages.getConversations",
      `access_token=${token}`,
    ),
    undefined,
  );
  assert.equal(
    tokenFromVkRequest(
      "http://api.vk.ru/method/messages.getConversations",
      `access_token=${token}`,
    ),
    undefined,
  );
});

async function browserFixture(complete: boolean) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const token = "vk1.a." + "c".repeat(64);
  const qrUrl = "https://qr.vk.ru/ca?q=fixture";
  const svg = (await QRCode.toString(qrUrl, { type: "svg" })).replace(
    "<svg ",
    '<svg class="QRCode__image--fixture" style="width:164px;height:164px" ',
  );
  let visits = 0;
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    let body = "";
    if (url.hostname === "id.vk.ru") body = svg;
    else if (url.hostname === "api.vk.ru")
      return route.fulfill({
        contentType: "application/json",
        body: '{"response":{}}',
      });
    else if (url.hostname === "vk.ru") {
      visits++;
      body =
        visits > 1
          ? `<script>fetch('https://api.vk.ru/method/messages.getConversations', {method:'POST',body:'access_token=${token}'})</script>`
          : `<iframe width="220" height="220" src="https://id.vk.ru/qr_auth"></iframe>${complete ? '<script>setTimeout(()=>{document.querySelector("iframe").remove();document.body.insertAdjacentHTML("beforeend", \'<a href="/im/convos">Мессенджер</a>\');},1800)</script>' : ""}`;
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  return { browser, context, token, qrUrl };
}

test(
  "VK QR uses an isolated headless browser and closes it after receiving a message token",
  { timeout: 15000 },
  async () => {
    let browser: Browser | undefined;
    const qr: string[] = [];
    const token = await loginWithVkQr({
      signal: new AbortController().signal,
      timeout: 10000,
      onQr: async (value) => {
        qr.push(value);
      },
      launch: async () => {
        const fixture = await browserFixture(true);
        browser = fixture.browser;
        return fixture;
      },
    });
    assert.equal(token, "vk1.a." + "c".repeat(64));
    assert.deepEqual(qr, ["https://qr.vk.ru/ca?q=fixture"]);
    assert.equal(browser?.isConnected(), false);
  },
);

test(
  "VK QR cancellation closes the browser while waiting for phone confirmation",
  { timeout: 15000 },
  async () => {
    const control = new AbortController();
    let browser: Browser | undefined;
    await assert.rejects(
      loginWithVkQr({
        signal: control.signal,
        timeout: 10000,
        onQr: async () => {
          control.abort();
        },
        launch: async () => {
          const fixture = await browserFixture(false);
          browser = fixture.browser;
          return fixture;
        },
      }),
      /отменён/,
    );
    assert.equal(browser?.isConnected(), false);
  },
);

test("VK QR decodes the official login link and rejects unrelated QR codes", async () => {
  const url = "https://qr.vk.ru/ca?q=test";
  assert.equal(decodeVkQr(await QRCode.toBuffer(url, { width: 220 })), url);
  assert.equal(
    decodeVkQr(
      await QRCode.toBuffer("https://example.org/login", { width: 220 }),
    ),
    undefined,
  );
});

test("VK QR reads form, JSON and bearer credentials without confusing them with ID tokens", () => {
  const url = "https://api.vk.ru/method/messages.getConversations";
  const token = "vk1.a." + "b".repeat(64);
  assert.equal(
    tokenFromVkRequest(url, JSON.stringify({ access_token: token })),
    token,
  );
  assert.equal(tokenFromVkRequest(url, null, `Bearer ${token}`), token);
  assert.equal(
    tokenFromVkRequest(url, JSON.stringify({ id_token: token })),
    undefined,
  );
});

for (const split of [false, true])
  test(
    `VK QR submits phone code in a separate VK ID page (split=${split})`,
    { timeout: 15000 },
    async () => {
      const fixture = await browserFixture(false);
      let prompts = 0;
      const result = loginWithVkQr({
        signal: new AbortController().signal,
        timeout: 10000,
        launch: async () => fixture,
        onQr: async () => {
          const confirmation = await fixture.context.newPage();
          await confirmation.route("https://id.vk.ru/auth", (route) =>
            route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: `<form><label>Код подтверждения${split ? '<input inputmode="numeric" maxlength="1">'.repeat(6) : '<input autocomplete="one-time-code" maxlength="6">'}</label><div role="alert"></div><button type="submit">Продолжить</button></form>
          <script>document.querySelector("form").onsubmit=e=>{e.preventDefault();if([...document.querySelectorAll("input")].map(input=>input.value).join("")==="012345"){window.confirmFixture();document.body.innerHTML="Подтверждено";}else{document.querySelector('[role=alert]').textContent='Неверный код';}}</script>`,
            }),
          );
          await confirmation.exposeFunction("confirmFixture", async () => {
            const main = fixture.context.pages()[0]!;
            await main.evaluate(() => {
              document.body.innerHTML = '<a href="/im/convos">Мессенджер</a>';
            });
          });
          await confirmation.goto("https://id.vk.ru/auth");
        },
        requestCode: async () => {
          prompts++;
          return prompts === 1 ? "999999" : "012345";
        },
      });
      assert.equal(await result, fixture.token);
      assert.equal(prompts, 2);
      assert.equal(fixture.browser.isConnected(), false);
    },
  );

test(
  "VK QR recognizes real VK ID otp-cell inputs without maxlength and automatic submission",
  { timeout: 15000 },
  async () => {
    const fixture = await browserFixture(false);
    let prompts = 0;
    const result = loginWithVkQr({
      signal: new AbortController().signal,
      timeout: 5000,
      launch: async () => fixture,
      onQr: async () => {
        const page = fixture.context.pages()[0]!;
        await page.route("https://id.vk.ru/auth", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<div>${'<input name="otp-cell" type="text" inputmode="numeric" class="vkc__TextField-module__input">'.repeat(6)}</div>
        <script>document.addEventListener("input",()=>{const code=[...document.querySelectorAll("input")].map(input=>input.value).join("");if(code==="012345"){window.confirmFixture();document.body.innerHTML="Подтверждено";}});</script>`,
          }),
        );
        await page.route("https://vk.ru/confirmed", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: '<a href="/im/convos">Мессенджер</a>',
          }),
        );
        await page.exposeFunction("confirmFixture", async () => {
          await page.goto("https://vk.ru/confirmed");
        });
        await page.goto("https://id.vk.ru/auth");
      },
      requestCode: async () => {
        prompts++;
        return "012345";
      },
    });
    assert.equal(await result, fixture.token);
    assert.equal(prompts, 1);
    assert.equal(fixture.browser.isConnected(), false);
  },
);

test(
  "VK QR cancels a pending phone-code prompt and closes Chromium",
  { timeout: 15000 },
  async () => {
    const fixture = await browserFixture(false);
    const control = new AbortController();
    await assert.rejects(
      loginWithVkQr({
        signal: control.signal,
        launch: async () => fixture,
        onQr: async () => {
          const frame = fixture.context
            .pages()[0]!
            .frames()
            .find((frame) => frame.url().startsWith("https://id.vk.ru/"))!;
          await frame.locator("body").evaluate((body) => {
            body.innerHTML =
              '<input autocomplete="one-time-code" maxlength="6">';
          });
        },
        requestCode: async (signal) => {
          control.abort();
          signal.throwIfAborted();
          return "012345";
        },
      }),
      /отменён/,
    );
    assert.equal(fixture.browser.isConnected(), false);
  },
);

test("VK QR accepts the exact official web API hosts", () => {
  const token = "vk1.a." + "d".repeat(64);
  for (const host of ["web.api.vk.ru", "web.api.vk.com"]) {
    assert.equal(
      tokenFromVkRequest(
        `https://${host}/method/messages.getConversations`,
        `access_token=${token}`,
      ),
      token,
    );
    assert.equal(
      tokenFromVkRequest(
        `https://${host}.evil.invalid/method/messages.getConversations`,
        `access_token=${token}`,
      ),
      undefined,
    );
  }
});
for (const host of ["api.vk.ru", "web.api.vk.ru"])
  test(
    `VK QR captures the first message request before navigation links render (${host})`,
    { timeout: 10000 },
    async () => {
      const fixture = await browserFixture(false);
      await fixture.context.route(`https://${host}/method/**`, (route) =>
        route.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: "{}",
        }),
      );
      const token = await loginWithVkQr({
        signal: new AbortController().signal,
        timeout: 2500,
        launch: async () => fixture,
        onQr: async () => {
          await fixture.context.pages()[0]!.evaluate(
            async ({ host, token }) => {
              await fetch(`https://${host}/method/execute`, {
                method: "POST",
                body: `access_token=vk1.a.${"x".repeat(64)}`,
              });
              await fetch(`https://${host}/method/messages.getConversations`, {
                method: "POST",
                body: `access_token=${token}`,
              });
            },
            { host, token: fixture.token },
          );
        },
      });
      assert.equal(token, fixture.token);
      assert.equal(fixture.browser.isConnected(), false);
    },
  );

test(
  "VK restores browser state and captures a new token without showing QR",
  { timeout: 15000 },
  async () => {
    const previousToken = "vk1.a." + "a".repeat(64);
    const token = "vk1.a." + "b".repeat(64);
    const wrongToken = "vk1.a." + "d".repeat(64);
    const tried: string[] = [];
    const state = {
      cookies: [],
      origins: [
        {
          origin: "https://vk.ru",
          localStorage: [{ name: "fixture-session", value: "active" }],
        },
      ],
    };
    let browser: Browser | undefined;
    const result = await restoreVkSession({
      state,
      previousToken,
      validate: async (candidate) => {
        tried.push(candidate);
        return candidate === token;
      },
      signal: new AbortController().signal,
      timeout: 8000,
      launch: async (storageState) => {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState });
        await context.route("https://vk.ru/im", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<script>
          const send = token => fetch('https://api.vk.ru/method/messages.getConversations', {method:'POST',body:'access_token='+token});
          send('${previousToken}');
          if (localStorage.getItem('fixture-session') === 'active') {
            localStorage.setItem('fixture-session', 'renewed');
            send('${wrongToken}');
            setTimeout(() => send('${token}'), 250);
          }
        </script>`,
          }),
        );
        await context.route("https://api.vk.ru/**", (route) =>
          route.fulfill({ status: 200 }),
        );
        return { browser, context };
      },
    });
    assert.equal(result?.token, token);
    assert.deepEqual(tried, [wrongToken, token]);
    assert.deepEqual(result?.state.origins[0]?.localStorage, [
      { name: "fixture-session", value: "renewed" },
    ]);
    assert.equal(browser?.isConnected(), false);
  },
);
