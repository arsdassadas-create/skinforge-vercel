// Vercel Function: normal withdrawal requests + admin-only Telegram test.
// The test action has a persistent global 24-hour cooldown stored in Upstash Redis.
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

const ADMIN_COOKIE = "sf_admin_session";
const TEST_COOLDOWN_KEY = "skinforge:telegram-withdrawal-test:global:v1";
const TEST_COOLDOWN_SECONDS = 24 * 60 * 60;

const GIFTS = Object.freeze({
  bear: { name: "Мишка", emoji: "🧸", cost: 500000, stars: 15 },
  rose: { name: "Красная роза", emoji: "🌹", cost: 1000000, stars: 25 }
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); }
      catch { return ""; }
    }
  }
  return "";
}

function isValidAdminSession(request, secret) {
  try {
    if (!secret || secret.length < 32) return false;
    const token = getCookie(request, ADMIN_COOKIE);
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return false;
    const expected = createHmac("sha256", secret).update(payload).digest("base64url");
    const received = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    if (received.length !== wanted.length || !timingSafeEqual(received, wanted)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.role === "admin" && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

async function redisCommand(command) {
  const url = String(
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || ""
  ).replace(/\/+$/, "");
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Не подключён Upstash Redis: добавь KV_REST_API_URL и KV_REST_API_TOKEN (или UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN) в Vercel.");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(7000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || `Upstash HTTP ${response.status}`);
  }
  return data.result;
}

async function getCooldownStatus() {
  const ttl = Number(await redisCommand(["TTL", TEST_COOLDOWN_KEY]));
  return {
    canTest: !(ttl > 0),
    retryAfter: ttl > 0 ? ttl : 0
  };
}

async function sendTelegramMessage(botToken, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      protect_content: true,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function handler(request) {
  if (!sameOrigin(request)) {
    return json({ ok: false, message: "Запрос с другого сайта заблокирован." }, 403);
  }

  // Admin-only status check: lets the UI show the real remaining cooldown.
  if (request.method === "GET") {
    const url = new URL(request.url);
    if (url.searchParams.get("testStatus") !== "1") {
      return json({ ok: false, message: "Метод не поддерживается." }, 405);
    }
    if (!isValidAdminSession(request, process.env.SKINFORGE_ADMIN_SESSION_SECRET)) {
      return json({ ok: false, message: "Только администратор может проверять тест вывода." }, 403);
    }
    try {
      const status = await getCooldownStatus();
      return json({ ok: true, ...status });
    } catch (error) {
      console.error("Test cooldown status error:", error?.message || error);
      return json({ ok: false, message: error?.message || "Не удалось проверить лимит теста." }, 503);
    }
  }

  if (request.method !== "POST") {
    return json({ ok: false, message: "Метод не поддерживается." }, 405);
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!botToken || !adminChatId) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID.");
    return json({ ok: false, message: "Telegram-бот не настроен в Vercel." }, 503);
  }

  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 10000) return json({ ok: false, message: "Слишком большой запрос." }, 413);
    const body = await request.json();

    // Test is separate from real withdrawals: no gift key, balance change, or request history.
    if (body?.test === true) {
      if (!isValidAdminSession(request, process.env.SKINFORGE_ADMIN_SESSION_SECRET)) {
        return json({ ok: false, message: "Тест вывода доступен только авторизованному администратору." }, 403);
      }

      const testId = "TEST-" + randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
      let reservation;
      try {
        reservation = await redisCommand([
          "SET", TEST_COOLDOWN_KEY, testId, "NX", "EX", TEST_COOLDOWN_SECONDS
        ]);
      } catch (error) {
        console.error("Test cooldown reservation error:", error?.message || error);
        return json({ ok: false, message: error?.message || "Не удалось проверить лимит теста." }, 503);
      }

      if (reservation !== "OK") {
        try {
          const status = await getCooldownStatus();
          const hours = Math.floor(status.retryAfter / 3600);
          const minutes = Math.ceil((status.retryAfter % 3600) / 60);
          return json({
            ok: false,
            retryAfter: status.retryAfter,
            message: `Тест уже отправлялся. Следующий можно сделать через ${hours} ч. ${minutes} мин.`
          }, 429);
        } catch (error) {
          console.error("Test cooldown lookup error:", error?.message || error);
          return json({ ok: false, message: "Тест уже зарезервирован. Повтори проверку позже." }, 429);
        }
      }

      const testTime = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Berlin" });
      const testMessage = [
        "🧪 <b>ТЕСТ ЧЕК SKINFORGE</b>",
        "",
        `<b>Проверка:</b> <code>${testId}</code>`,
        `<b>Время:</b> ${escapeHTML(testTime)}`,
        "",
        "✅ Telegram Bot API принял тестовое сообщение.",
        "Это НЕ заявка на подарок. Баланс не списывался, подарок не заказывался.",
        "Следующий тест чек будет доступен через 24 часа."
      ].join("\n");

      try {
        const { response, data } = await sendTelegramMessage(botToken, adminChatId, testMessage);
        if (!response.ok || !data.ok) {
          // Release the 24h reservation only when Telegram explicitly rejects the message.
          await redisCommand(["DEL", TEST_COOLDOWN_KEY]).catch(() => {});
          console.error("Telegram test sendMessage failed:", data.description || response.status);
          return json({ ok: false, message: "Telegram не принял тестовое сообщение. Можно попробовать ещё раз." }, 502);
        }
      } catch (error) {
        // Keep the reservation on network timeout: Telegram may have accepted the message,
        // so releasing it could allow a duplicate test immediately.
        console.error("Telegram test delivery uncertain:", error?.message || error);
        return json({ ok: false, message: "Не удалось подтвердить отправку теста. Лимит сохранён на 24 часа, чтобы не отправить дубликат." }, 502);
      }

      return json({
        ok: true,
        test: true,
        requestId: testId,
        retryAfter: TEST_COOLDOWN_SECONDS
      });
    }

    const giftKey = String(body?.giftKey || "");
    const gift = GIFTS[giftKey];
    if (!gift) return json({ ok: false, message: "Неизвестный подарок." }, 400);

    const playerName = String(body?.playerName || "Гость").trim().slice(0, 32);
    let recipient = String(body?.recipient || "").trim();
    const phoneRaw = String(body?.phoneNumber || "").trim();

    if (!/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(recipient)) {
      return json({ ok: false, message: "Укажи корректный Telegram username получателя." }, 400);
    }
    if (!recipient.startsWith("@")) recipient = "@" + recipient;

    let phoneNumber = "";
    if (phoneRaw) {
      phoneNumber = "+" + phoneRaw.replace(/\D/g, "");
      if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
        return json({ ok: false, message: "Укажи телефон с кодом страны, от 8 до 15 цифр." }, 400);
      }
    }

    const requestId = "SF-" + randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const localTime = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Berlin" });
    const message = [
      "🎁 <b>НОВАЯ ЗАЯВКА НА ВЫВОД SKINFORGE</b>",
      "",
      `<b>Номер:</b> <code>${requestId}</code>`,
      `<b>Игрок:</b> ${escapeHTML(playerName || "Гость")}`,
      `<b>Подарок:</b> ${gift.emoji} <b>${escapeHTML(gift.name)}</b>`,
      `<b>Стоимость:</b> ${gift.cost.toLocaleString("ru-RU")}`,
      `<b>Telegram получатель:</b> ${escapeHTML(recipient)}`,
      ...(phoneNumber ? [`<b>Телефон:</b> ${escapeHTML(phoneNumber)}`] : []),
      `<b>Telegram Stars:</b> ${gift.stars}`,
      `<b>Время:</b> ${escapeHTML(localTime)}`,
      "",
      "Статус: <b>ожидает ручной обработки</b>"
    ].join("\n");

    const { response: telegramResponse, data: telegramData } = await sendTelegramMessage(botToken, adminChatId, message);
    if (!telegramResponse.ok || !telegramData.ok) {
      console.error("Telegram sendMessage failed:", telegramData.description || telegramResponse.status);
      return json({ ok: false, message: "Telegram не принял сообщение. Заявка не отправлена." }, 502);
    }
    return json({ ok: true, requestId, status: "SENT_TO_ADMIN" });
  } catch (error) {
    console.error("Withdrawal function error:", error?.message || error);
    return json({ ok: false, message: "Ошибка сервера при отправке заявки." }, 500);
  }
}

export default { fetch: handler };