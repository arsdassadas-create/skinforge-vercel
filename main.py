
import os
import json
import hmac
import urllib.request
import urllib.error
from flask import request, jsonify

SKINFORGE_API_SECRET = os.getenv("SKINFORGE_API_SECRET", "")

@app.route("/api/skinforge/withdrawal", methods=["POST"])
def skinforge_withdrawal():
    # Проверка секретного ключа сайта
    provided_secret = request.headers.get("X-SkinForge-Secret", "")

    if not SKINFORGE_API_SECRET or not hmac.compare_digest(
        provided_secret, SKINFORGE_API_SECRET
    ):
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}

    username = str(data.get("username", "Не указан"))[:100]
    telegram = str(data.get("telegram", "Не указан"))[:100]
    gift = str(data.get("gift", "Не указан"))[:100]
    amount = str(data.get("amount", "Не указана"))[:50]
    request_id = str(data.get("request_id", "Без ID"))[:100]

    message = (
        "🎁 НОВАЯ ЗАЯВКА SKINFORGE\n\n"
        f"🆔 Заявка: {request_id}\n"
        f"👤 Аккаунт: {username}\n"
        f"📱 Telegram: {telegram}\n"
        f"🎁 Подарок: {gift}\n"
        f"💰 Сумма: {amount}\n\n"
        "⏳ Статус: ожидает обработки"
    )

    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    admin_chat_id = os.getenv("TELEGRAM_ADMIN_CHAT_ID")

    if not bot_token or not admin_chat_id:
        return jsonify({"ok": False, "error": "Telegram not configured"}), 500

    payload = {
        "chat_id": admin_chat_id,
        "text": message
    }

    telegram_url = f"https://api.telegram.org/bot{bot_token}/sendMessage"

    req = urllib.request.Request(
        telegram_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))

        if result.get("ok"):
            return jsonify({"ok": True, "message": "Withdrawal sent"}), 200

        return jsonify({"ok": False, "error": "Telegram rejected request"}), 502

    except Exception:
        return jsonify({"ok": False, "error": "Telegram delivery failed"}), 502
