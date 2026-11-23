import {
  createHmac,
  createHash,
  timingSafeEqual
} from "node:crypto";

const COOKIE = "sf_admin_session";
const MAX_AGE = 8 * 60 * 60;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });

const b64 = (value) =>
  Buffer.from(value).toString("base64url");

const sign = (payload, secret) =>
  createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";

  for (const part of raw.split(";")) {
    const index = part.indexOf("=");

    if (
      index > 0 &&
      part.slice(0, index).trim() === name
    ) {
      return decodeURIComponent(
        part.slice(index + 1).trim()
      );
    }
  }

  return "";
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");

  if (!origin) return true;

  try {
    return new URL(origin).origin ===
      new URL(request.url).origin;
  } catch {
    return false;
  }
}

function validToken(token, secret) {
  try {
    const [payload, signature] = token.split(".");

    if (!payload || !signature) return false;

    const expected = sign(payload, secret);

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (
      a.length !== b.length ||
      !timingSafeEqual(a, b)
    ) {
      return false;
    }

    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return (
      data.role === "admin" &&
      Number(data.exp) > Math.floor(Date.now() / 1000)
    );

  } catch {
    return false;
  }
}

async function handler(request) {
  const username = process.env.SKINFORGE_ADMIN_USERNAME;
  const password = process.env.SKINFORGE_ADMIN_PASSWORD;
  const secret = process.env.SKINFORGE_ADMIN_SESSION_SECRET;

  if (
    !username ||
    !password ||
    !secret ||
    secret.length < 32
  ) {
    return json({
      ok: false,
      message: "Администратор не настроен в Vercel."
    }, 503);
  }

  if (!sameOrigin(request)) {
    return json({
      ok: false,
      message: "Запрос с другого сайта запрещён."
    }, 403);
  }

  if (request.method === "GET") {
    const token = getCookie(request, COOKIE);
    const ok = Boolean(token && validToken(token, secret));

    return json({
      ok,
      admin: ok
    });
  }

  if (request.method === "DELETE") {
    return json({ ok: true }, 200, {
      "set-cookie":
        `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
    });
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      message: "Метод не поддерживается."
    }, 405);
  }

  try {
    const length = Number(
      request.headers.get("content-length") || 0
    );

    if (length > 5000) {
      return json({
        ok: false,
        message: "Слишком большой запрос."
      }, 413);
    }

    const body = await request.json();

    const gotUser = String(body?.username || "");
    const gotPass = String(body?.password || "");

    const equal = (a, b) => {
      const aa = createHash("sha256").update(a).digest();
      const bb = createHash("sha256").update(b).digest();

      return timingSafeEqual(aa, bb);
    };

    if (
      gotUser.length > 64 ||
      gotPass.length > 256 ||
      !equal(gotUser, username) ||
      !equal(gotPass, password)
    ) {
      return json({
        ok: false,
        message: "Неверный логин или пароль."
      }, 401);
    }

    const now = Math.floor(Date.now() / 1000);

    const payload = b64(JSON.stringify({
      role: "admin",
      iat: now,
      exp: now + MAX_AGE
    }));

    const token = `${payload}.${sign(payload, secret)}`;

    return json({
      ok: true,
      admin: true
    }, 200, {
      "set-cookie":
        `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`
    });

  } catch (error) {
    console.error(
      "Admin auth error:",
      error?.message || error
    );

    return json({
      ok: false,
      message: "Ошибка проверки доступа."
    }, 400);
  }
}

export default { fetch: handler };