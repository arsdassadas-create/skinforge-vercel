import { createHash, createHmac, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const COOKIE = "sf_admin_session";
const EVERGREEN_CODE = "SKIN5K";
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[ch]);

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}
function isAdmin(request) {
  try {
    const secret = process.env.SKINFORGE_ADMIN_SESSION_SECRET || "";
    if (secret.length < 32) return false;
    const [payload, signature] = getCookie(request, COOKIE).split(".");
    if (!payload || !signature) return false;
    const expected = createHmac("sha256", secret).update(payload).digest("base64url");
    const a = Buffer.from(signature), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.role === "admin" && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
async function redisCommand(command) {
  const url = String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis не настроен в Vercel.");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `Upstash HTTP ${response.status}`);
  return data.result;
}
async function sendTelegram(text, chatId = process.env.TELEGRAM_ADMIN_CHAT_ID) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN или TELEGRAM_ADMIN_CHAT_ID не настроен в Vercel.");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", protect_content: true, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
function promoKey(code) { return `skinforge:promo:code:${hash(code)}`; }
function userClaimsKey(playerId) { return `skinforge:promo:claims:${hash(playerId)}`; }
async function ensureEvergreen() {
  const codeHash = hash(EVERGREEN_CODE);
  const key = `skinforge:promo:code:${codeHash}`;
  const record = { codeHash, kind: "balance", reward: 5000, maxUses: -1, uses: 0, expiresAt: 0, label: "Permanent SkinForge 5K" };
  await redisCommand(["SET", key, JSON.stringify(record), "NX"]);
  return key;
}

const CLAIM_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'NOT_FOUND'} end
local p = cjson.decode(raw)
local exp = tonumber(p.expiresAt or 0)
if exp > 0 and tonumber(ARGV[1]) > exp then return {'EXPIRED'} end
if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1 then return {'ALREADY_USED'} end
local maxUses = tonumber(p.maxUses or -1)
if maxUses >= 0 and tonumber(p.uses or 0) >= maxUses then return {'LIMIT'} end
if p.kind == 'bear' and ARGV[3] == '' then return {'NEED_RECIPIENT'} end
redis.call('SADD', KEYS[2], ARGV[2])
local oldTtl = redis.call('PTTL', KEYS[1])
p.uses = tonumber(p.uses or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(p))
if oldTtl > 0 then redis.call('PEXPIRE', KEYS[1], oldTtl) end
return {'OK', tostring(p.kind), tostring(p.reward or 0), tostring(p.uses), tostring(maxUses)}
`;
const RELEASE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local p = cjson.decode(raw)
local removed = redis.call('SREM', KEYS[2], ARGV[1])
if removed == 1 then
  local oldTtl = redis.call('PTTL', KEYS[1])
  p.uses = math.max(0, tonumber(p.uses or 0) - 1)
  redis.call('SET', KEYS[1], cjson.encode(p))
  if oldTtl > 0 then redis.call('PEXPIRE', KEYS[1], oldTtl) end
end
return removed
`;

async function createBearCode() {
  const token = randomBytes(4).toString("hex").toUpperCase();
  const code = `BEAR-${token}`;
  const codeHash = hash(code);
  const record = { codeHash, kind: "bear", reward: 0, maxUses: 2, uses: 0, expiresAt: 0, label: "Secret Bear Promo" };
  const result = await redisCommand(["SET", `skinforge:promo:code:${codeHash}`, JSON.stringify(record), "NX"]);
  if (result !== "OK") throw new Error("Не удалось сохранить промокод. Повтори создание.");
  try {
    const sent = await sendTelegram(`🧸 <b>СЕКРЕТНЫЙ ПРОМОКОД SKINFORGE</b>\n\n<code>${code}</code>\n\n🎁 Награда: заявка на Telegram-подарок «Мишка»\n🔐 Лимит: ровно 2 активации на всех игроков\n\nПередай код двум игрокам. После двух успешных заявок код перестанет работать.`);
    if (!sent.response.ok || !sent.data.ok) throw new Error(sent.data.description || "Telegram не принял сообщение.");
  } catch (error) {
    await redisCommand(["DEL", `skinforge:promo:code:${codeHash}`]).catch(() => {});
    throw new Error(`Код не создан: не удалось отправить уведомление в Telegram (${error.message}).`);
  }
  return code;
}

async function redeem(body) {
  const code = String(body?.code || "").trim().toUpperCase().replace(/\s+/g, "");
  const playerId = String(body?.playerId || "").trim();
  const playerName = String(body?.playerName || "Игрок").trim().slice(0, 40);
  let recipient = String(body?.recipient || "").trim();
  if (!/^[A-Z0-9-]{4,48}$/.test(code)) return json({ ok: false, message: "Проверь промокод: допустимы латинские буквы и цифры." }, 400);
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(playerId)) return json({ ok: false, message: "Войди в игровой аккаунт перед активацией промокода." }, 401);
  if (code === EVERGREEN_CODE) await ensureEvergreen();

  const key = promoKey(code);
  const raw = await redisCommand(["GET", key]);
  if (!raw) return json({ ok: false, message: "Такого промокода нет или срок его действия закончился." }, 404);
  let record;
  try { record = JSON.parse(raw); } catch { return json({ ok: false, message: "Не удалось прочитать промокод." }, 500); }

  let phoneNumber = String(body?.phoneNumber || "").trim();
  if (record.kind === "bear") {
    if (!/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(recipient)) return json({ ok: false, message: "Для кода на Мишку укажи Telegram username получателя." }, 400);
    if (!recipient.startsWith("@")) recipient = `@${recipient}`;
    if (phoneNumber) {
      phoneNumber = `+${phoneNumber.replace(/\D/g, "")}`;
      if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) return json({ ok: false, message: "Проверь телефон или оставь поле пустым." }, 400);
    }
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) return json({ ok: false, message: "Telegram-бот не настроен в Vercel." }, 503);
  }

  const userKey = userClaimsKey(playerId);
  let result;
  try {
    result = await redisCommand(["EVAL", CLAIM_LUA, "2", key, userKey, String(Math.floor(Date.now() / 1000)), record.codeHash, recipient]);
  } catch (error) {
    return json({ ok: false, message: `Не удалось проверить лимит промокода в Upstash: ${error.message}` }, 503);
  }
  const status = Array.isArray(result) ? String(result[0]) : String(result);
  if (status !== "OK") {
    const messages = {
      NOT_FOUND: "Промокод не найден.", EXPIRED: "Срок действия промокода закончился.",
      ALREADY_USED: "Ты уже активировал этот промокод на своём аккаунте.",
      LIMIT: "Все активации этого промокода уже использованы.",
      NEED_RECIPIENT: "Укажи Telegram username для получения Мишки."
    };
    return json({ ok: false, message: messages[status] || "Не удалось активировать промокод." }, 409);
  }

  const kind = String(result[1]);
  const reward = Number(result[2]) || 0;
  if (kind === "bear") {
    const requestId = "PROMO-BEAR-" + randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const time = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Vientiane" });
    const message = [
      "🧸 <b>ЗАЯВКА НА МИШКУ ПО ПРОМОКОДУ</b>", "",
      `<b>Номер:</b> <code>${requestId}</code>`,
      `<b>Игрок:</b> ${escapeHTML(playerName)}`,
      `<b>Telegram получатель:</b> ${escapeHTML(recipient)}`,
      ...(phoneNumber ? [`<b>Телефон:</b> ${escapeHTML(phoneNumber)}`] : []),
      `<b>Промокод:</b> <code>${code}</code>`,
      `<b>Использовано активаций:</b> ${escapeHTML(result[3])}/2`,
      `<b>Время:</b> ${escapeHTML(time)}`, "", "Статус: <b>ожидает ручной выдачи</b>"
    ].join("\n");
    try {
      const sent = await sendTelegram(message);
      if (!sent.response.ok || !sent.data.ok) throw new Error(sent.data.description || `Telegram HTTP ${sent.response.status}`);
    } catch (error) {
      // Release a use if Telegram explicitly failed; uncertain network outcomes remain claimed to avoid duplicates.
      if (error.message && !/fetch failed|timeout|timed out|aborted/i.test(error.message)) {
        await redisCommand(["EVAL", RELEASE_LUA, "2", key, userKey, record.codeHash]).catch(() => {});
      }
      return json({ ok: false, message: "Не удалось подтвердить отправку заявки в Telegram. Проверь чат с ботом перед повторной активацией." }, 502);
    }
    return json({ ok: true, kind: "bear", requestId, uses: Number(result[3]) || 0, maxUses: 2 });
  }
  if (kind !== "balance" || reward < 1) return json({ ok: false, message: "Неизвестный тип награды." }, 500);
  return json({ ok: true, kind: "balance", reward, uses: Number(result[3]) || 0 });
}

async function handler(request) {
  if (!sameOrigin(request)) return json({ ok: false, message: "Запрос с другого сайта запрещён." }, 403);
  if (request.method !== "POST") return json({ ok: false, message: "Метод не поддерживается." }, 405);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 8000) return json({ ok: false, message: "Слишком большой запрос." }, 413);
  try {
    const body = await request.json();
    if (body?.action === "createBear") {
      if (!isAdmin(request)) return json({ ok: false, message: "Создавать секретный код может только администратор." }, 403);
      if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) return json({ ok: false, message: "Сначала настрой Telegram в Vercel." }, 503);
      const code = await createBearCode();
      return json({ ok: true, code, maxUses: 2 });
    }
    if (body?.action === "redeem") return await redeem(body);
    return json({ ok: false, message: "Неизвестное действие." }, 400);
  } catch (error) {
    console.error("Promo API error:", error?.message || error);
    return json({ ok: false, message: error?.message || "Ошибка сервера промокодов." }, 500);
  }
}
export default { fetch: handler };
