import { createHash, randomBytes } from "node:crypto";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const hash = value => createHash("sha256").update(String(value)).digest("hex");
async function redisCommand(command) {
  const url = String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis не настроен.");
  const response = await fetch(url, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(8000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `Upstash HTTP ${response.status}`);
  return data.result;
}
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_PROMO_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram bot / promo chat is not configured.");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML", protect_content: true, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${response.status}`);
}
async function handler(request) {
  if (request.method !== "GET") return json({ ok: false }, 405);
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return json({ ok: false, message: "Unauthorized" }, 401);
  try {
    const now = new Date();
    const week = isoWeek(now);
    const weekKey = `skinforge:promo:weekly:${week}`;
    const existing = await redisCommand(["GET", weekKey]);
    let promo;
    if (existing) {
      promo = JSON.parse(existing);
    } else {
      const code = `FRI10K-${week.replace("-", "")}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const codeHash = hash(code);
      const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
      promo = { code, codeHash, kind: "balance", reward: 10000, maxUses: -1, uses: 0, expiresAt, label: "Weekly Friday 10K" };
      const created = await redisCommand(["SET", weekKey, JSON.stringify(promo), "NX", "EX", 8 * 86400]);
      if (created !== "OK") {
        const winner = await redisCommand(["GET", weekKey]);
        if (!winner) throw new Error("Не удалось сохранить пятничный промокод.");
        promo = JSON.parse(winner);
      }
    }
    const promoKey = `skinforge:promo:code:${promo.codeHash}`;
    await redisCommand(["SET", promoKey, JSON.stringify({ codeHash: promo.codeHash, kind: promo.kind, reward: 10000, maxUses: -1, uses: Number(promo.uses) || 0, expiresAt: Number(promo.expiresAt), label: promo.label }), "NX", "EX", 8 * 86400]);

    const sentKey = `skinforge:promo:weekly-notified:${week}`;
    const shouldSend = await redisCommand(["SET", sentKey, "1", "NX", "EX", 8 * 86400]);
    if (shouldSend === "OK") {
      try {
        await sendTelegram([
          "🎉 <b>ПЯТНИЧНЫЙ ПРОМОКОД SKINFORGE</b>", "",
          `<code>${promo.code}</code>`, "",
          "💰 Награда: <b>+10 000</b> к игровому балансу", "",
          "Активировать можно на сайте SkinForge. Код действует 7 дней и один раз на аккаунт."
        ].join("\n"));
      } catch (error) {
        await redisCommand(["DEL", sentKey]).catch(() => {});
        throw error;
      }
    }
    return json({ ok: true, week, notified: shouldSend === "OK", expiresAt: promo.expiresAt });
  } catch (error) {
    console.error("Weekly promo cron error:", error?.message || error);
    return json({ ok: false, message: error?.message || "Weekly promo error" }, 500);
  }
}
export default { fetch: handler };
