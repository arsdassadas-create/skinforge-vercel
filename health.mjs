async function handler(request) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
  const telegramConfigured = Boolean(
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID
  );
  const redisConfigured = Boolean(
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
  );
  const testCooldownConfigured = redisConfigured;
  const promoConfigured = redisConfigured;
  const weeklyPromoCronConfigured = Boolean(process.env.CRON_SECRET);
  return new Response(JSON.stringify({ ok: true, telegramConfigured, testCooldownConfigured, promoConfigured, weeklyPromoCronConfigured }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
export default { fetch: handler };
