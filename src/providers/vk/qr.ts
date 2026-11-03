import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Frame,
} from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import { decodeVkQr, tokenFromVkRequest } from "./qr-helpers.js";

type BrowserSession = { browser: Browser; context: BrowserContext };

async function launchSession(): Promise<BrowserSession> {
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      return {
        browser,
        context: await browser.newContext({
          viewport: { width: 1280, height: 900 },
        }),
      };
    } catch (error) {
      await browser.close();
      throw error;
    }
  } catch {
    throw new Error(
      "Не удалось запустить невидимый Chromium. Выполните npm run setup:vk-qr.",
    );
  }
}

async function qrOnPage(page: Page): Promise<string | undefined> {
  for (const frame of page.frames()) {
    let url: URL;
    try {
      url = new URL(frame.url());
    } catch {
      continue;
    }
    if (!["id.vk.ru", "id.vk.com"].includes(url.hostname)) continue;
    const images = frame.locator(
      'svg[class*="QRCode__image"], canvas, img[alt*="QR"], img[alt*="qr"]',
    );
    const count = await images.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 8); index++) {
      const image = images.nth(index);
      const bounds = await image.boundingBox().catch(() => null);
      if (
        !bounds ||
        bounds.width < 90 ||
        bounds.height < 90 ||
        bounds.width > 600 ||
        bounds.height > 600
      )
        continue;
      const png = await image
        .screenshot({ timeout: 1500 })
        .catch(() => undefined);
      const value = png && decodeVkQr(png);
      if (value) return value;
    }
  }
}

async function submitConfirmationCode(
  context: BrowserContext,
  requestCode: (signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  submitted: Map<Frame, string>,
  onCodeEntered?: () => void,
): Promise<void> {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      let url: URL;
      try {
        url = new URL(frame.url());
      } catch {
        continue;
      }
      if (
        url.protocol !== "https:" ||
        !["vk.ru", "vk.com", "id.vk.ru", "id.vk.com"].includes(url.hostname)
      )
        continue;
      const inputs = frame.locator(
        'input[name="otp-cell"]:visible, input[autocomplete="one-time-code"]:visible, input[name="code"]:visible, input[name="otp"]:visible, input[name="auth_code"]:visible, input[name="otp_code"]:visible, input[inputmode="numeric"][maxlength="6"]:visible, input[inputmode="numeric"][maxlength="1"]:visible',
      );
      const count = await inputs.count().catch(() => 0);
      if (count !== 1 && count !== 6) continue;
      if (
        count === 1 &&
        (await inputs.getAttribute("maxlength").catch(() => null)) === "1"
      )
        continue;
      if (
        count === 6 &&
        !(await inputs
          .evaluateAll((elements) =>
            elements.every(
              (element) =>
                element.getAttribute("maxlength") === "1" ||
                element.getAttribute("name") === "otp-cell",
            ),
          )
          .catch(() => false))
      )
        continue;
      const current = await inputs
        .evaluateAll((elements) =>
          elements
            .map((element) => (element as HTMLInputElement).value)
            .join(""),
        )
        .catch(() => "");
      const rejected = await frame
        .locator(
          '[role="alert"]:visible, [class*="error"]:visible, [class*="Error"]:visible',
        )
        .allTextContents()
        .then((texts) =>
          texts.some((text) =>
            /неверн|неправильн|ошиб|incorrect|invalid/i.test(text),
          ),
        )
        .catch(() => false);
      if (submitted.has(frame) && current === submitted.get(frame) && !rejected)
        continue;
      const code = await requestCode(signal);
      signal.throwIfAborted();
      if (!/^\d{6}$/.test(code))
        throw new Error("Код подтверждения VK должен содержать 6 цифр.");
      if (count === 1) await inputs.fill(code, { timeout: 5000 });
      else
        for (let index = 0; index < 6; index++)
          await inputs.nth(index).fill(code[index]!, { timeout: 5000 });
      submitted.set(frame, code);
      onCodeEntered?.();
      if (frame.isDetached() || !(await inputs.count().catch(() => 0)))
        continue;
      const button = frame
        .getByRole("button", {
          name: /^(?:Продолжить|Подтвердить|Войти|Continue|Confirm|Sign in)$/i,
        })
        .filter({ visible: true });
      if (await button.count()) await button.first().click({ timeout: 5000 });
      else if (
        count !== 6 ||
        (await inputs.first().getAttribute("name")) !== "otp-cell"
      )
        await inputs.last().press("Enter", { timeout: 5000 });
    }
  }
}

export async function loginWithVkQr(options: {
  signal: AbortSignal;
  onQr: (value: string) => Promise<void>;
  requestCode?: (signal: AbortSignal) => Promise<string>;
  onStatus?: (status: "code-entered" | "opening-messages") => void;
  launch?: () => Promise<BrowserSession>;
  timeout?: number;
}): Promise<string> {
  options.signal.throwIfAborted();
  const { browser, context } = await (options.launch ?? launchSession)();
  const abort = () => {
    void browser.close().catch(() => undefined);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  let signedIn = false;
  let candidate: string | undefined;
  let lastQr = "";
  let openedMessages = false;
  const submitted = new Map<Frame, string>();
  const deadline = Date.now() + (options.timeout ?? 180_000);
  try {
    options.signal.throwIfAborted();
    context.on("request", (request) => {
      if (!lastQr || candidate) return;
      if (!signedIn && new URL(request.url()).pathname === "/method/execute")
        return;
      candidate = tokenFromVkRequest(
        request.url(),
        request.postData(),
        request.headers().authorization,
      );
    });
    const page = await context.newPage();
    await page.goto("https://vk.ru/im", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    while (Date.now() < deadline) {
      options.signal.throwIfAborted();
      if (candidate) return candidate;
      if (
        lastQr &&
        (await page
          .locator('a[href="/im"], a[href^="/im/"], a[href^="/im?"]')
          .evaluateAll((links) =>
            links.some((link) => {
              const bounds = link.getBoundingClientRect();
              return bounds.width > 0 && bounds.height > 0;
            }),
          )
          .catch(() => false))
      ) {
        signedIn = true;
        if (!openedMessages) {
          openedMessages = true;
          options.onStatus?.("opening-messages");
          await page.goto("https://vk.ru/im", {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
        }
      }
      if (lastQr && options.requestCode) {
        const promptSignal = AbortSignal.any([
          options.signal,
          AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        ]);
        try {
          await submitConfirmationCode(
            context,
            options.requestCode,
            promptSignal,
            submitted,
            () => options.onStatus?.("code-entered"),
          );
        } catch (error) {
          if (promptSignal.aborted && !options.signal.aborted)
            throw new Error("Время QR-входа VK истекло. Повторите команду.");
          throw error;
        }
      }
      const qr = await qrOnPage(page);
      if (qr && qr !== lastQr) {
        lastQr = qr;
        await options.onQr(qr);
      }
      await delay(750, undefined, { signal: options.signal });
    }
    throw new Error(
      lastQr
        ? "Время QR-входа VK истекло. Подтвердите вход в приложении VK на телефоне и повторите команду."
        : "VK не показал распознаваемый QR-код. Страница входа могла измениться или запросить дополнительную проверку.",
    );
  } catch (error) {
    if (options.signal.aborted) throw new Error("QR-вход VK отменён.");
    if (
      error instanceof Error &&
      (error.message.startsWith("Время QR-входа") ||
        error.message.startsWith("VK не показал") ||
        error.message.startsWith("Код подтверждения VK"))
    )
      throw error;
    throw new Error(
      "Не удалось завершить QR-вход VK через страницу входа. Повторите команду; если VK требует дополнительную проверку, завершите её в приложении на телефоне.",
    );
  } finally {
    options.signal.removeEventListener("abort", abort);
    await browser.close().catch(() => undefined);
  }
}
