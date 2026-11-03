import type { SentCodeInfo } from "teleproto/client/auth";

export function codeDeliveryHint(
  viaApp?: boolean,
  info?: Pick<SentCodeInfo, "type" | "length" | "pattern" | "prefix">,
): string {
  const type = info?.type ?? (viaApp === true ? "app" : undefined);
  const destinations = {
    app: "Ищите код в служебном чате Telegram на устройстве, где уже выполнен вход.",
    sms: "Telegram выбрал доставку кода по SMS.",
    call: "Telegram выбрал звонок: код продиктует голосовой помощник.",
    flashCall: "Telegram выбрал короткий звонок: кодом будет номер звонящего.",
    missedCall:
      "Telegram выбрал пропущенный звонок: введите последние цифры номера звонящего.",
    fragment: "Telegram выбрал доставку через Fragment.",
    smsWord: "Telegram выбрал SMS со словом: введите слово целиком.",
    smsPhrase: "Telegram выбрал SMS с фразой: введите фразу целиком.",
  };
  if (!type) return "Telegram не сообщил способ доставки кода.";
  return `${destinations[type]} Способ: ${type}.${info?.length ? ` Длина кода: ${info.length}.` : ""}`;
}
