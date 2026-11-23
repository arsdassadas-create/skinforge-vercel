// Vercel Function: sends SkinForge withdrawal requests to the admin's Telegram.

const GIFTS = Object.freeze({
  bear: {
    name: "Мишка",
    emoji: "🧸",
    cost: 500000,
    stars: 15
  },
  rose: {
    name: "Красная роза",
    emoji: "🌹",
    cost: 1000000,
    stars: 25
  }
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
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

async function handler(request) {
  if (request.method !== "POST") {
    return json({
      ok: false,
      message: "Метод не поддерживается."
    }, 405);
  }

  const origin = request.headers.get("origin");

  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) {
        return json({
          ok: false,
          message: "Запрос с другого сайта заблокирован."
        }, 403);
      }
    } catch {
      return json({
        ok: false,
        message: "Некорректный источник запроса."
      }, 403);
    }
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!botToken || !adminChatId) {
    console.error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID."
    );

    return json({
      ok: false,
      message: "Telegram-бот не настроен в Vercel."
    }, 503);
  }

  try {
    const contentLength = Number(
      request.headers.get("content-length") || 0
    );

    if (contentLength > 10000) {
      return json({
        ok: false,
        message: "Слишком большой запрос."
      }, 413);
    }

    const body = await request.json();

    const giftKey = String(body?.giftKey || "");
    const gift = GIFTS[giftKey];

    if (!gift) {
      return json({
        ok: false,
        message: "Неизвестный подарок."
      }, 400);
    }

    const playerName = String(
      body?.playerName || "Гость"
    ).trim().slice(0, 32);

    let recipient = String(
      body?.recipient || ""
    ).trim();

    const phoneRaw = String(
      body?.phoneNumber || ""
    ).trim();

    if (!/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(recipient)) {
      return json({
        ok: false,
        message: "Укажи корректный Telegram username получателя."
      }, 400);
    }

    if (!recipient.startsWith("@")) {
      recipient = "@" + recipient;
    }

    let phoneNumber = "";

    if (phoneRaw) {
      phoneNumber = "+" + phoneRaw.replace(/\D/g, "");

      if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
        return json({
          ok: false,
          message: "Укажи телефон с кодом страны, от 8 до 15 цифр."
        }, 400);
      }
    }

    const requestId =
      "SF-" +
      crypto.randomUUID()
        .replace(/-/g, "")
        .slice(0, 8)
        .toUpperCase();

    const createdAt = new Date();

    const localTime = createdAt.toLocaleString(
      "ru-RU",
      { timeZone: "Europe/Berlin" }
    );

    const message = [
      "🎁 <b>НОВАЯ ЗАЯВКА НА ВЫВОД SKINFORGE</b>",
      "",
      `<b>Номер:</b> <code>${requestId}</code>`,
      `<b>Игрок:</b> ${escapeHTML(playerName || "Гость")}`,
      `<b>Подарок:</b> ${gift.emoji} <b>${escapeHTML(gift.name)}</b>`,
      `<b>Стоимость:</b> ${gift.cost.toLocaleString("ru-RU")}`,
      `<b>Telegram получатель:</b> ${escapeHTML(recipient)}`,
      ...(phoneNumber
        ? [`<b>Телефон:</b> ${escapeHTML(phoneNumber)}`]
        : []),
      `<b>Telegram Stars:</b> ${gift.stars}`,
      `<b>Время:</b> ${escapeHTML(localTime)}`,
      "",
      "Статус: <b>ожидает ручной обработки</b>"
    ].join("\n");

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: message,
          parse_mode: "HTML",
          protect_content: true,
          disable_web_page_preview: true
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    const telegramData = await telegramResponse
      .json()
      .catch(() => ({}));

    if (!telegramResponse.ok || !telegramData.ok) {
      console.error(
        "Telegram sendMessage failed:",
        telegramData.description || telegramResponse.status
      );

      return json({
        ok: false,
        message: "Telegram не принял сообщение. Заявка не отправлена."
      }, 502);
    }

    return json({
      ok: true,
      requestId,
      status: "SENT_TO_ADMIN"
    });

  } catch (error) {
    console.error(
      "Withdrawal function error:",
      error?.message || error
    );

    return json({
      ok: false,
      message: "Ошибка сервера при отправке заявки."
    }, 500);
  }
}

export default { fetch: handler };