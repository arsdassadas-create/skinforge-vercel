import os
import uuid
import hmac
import logging
from html import escape
from threading import Thread, Lock

import telebot
from flask import Flask, request, jsonify
from flask_cors import CORS
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("skinforge-bot")

# Store secrets in Render > Environment. Never put tokens in this file.
BOT_TOKEN = (os.environ.get("8955553619:AAFEWkgbftYaAV6FoXRT2l2rQmkSYfNJMzU") or os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
ADMIN_CHAT_ID = (os.environ.get("8998213268") or os.environ.get("TELEGRAM_ADMIN_CHAT_ID") or "").strip()
SKINFORGE_API_SECRET = os.environ.get("SKINFORGE_API_SECRET", "").strip()

if not BOT_TOKEN:
    raise RuntimeError("Set BOT_TOKEN (or TELEGRAM_BOT_TOKEN) in Render Environment")

bot = telebot.TeleBot(BOT_TOKEN)
app = Flask(__name__)
CORS(app)

orders = {}
orders_lock = Lock()

GIFTS = {
    "bear": {"name": "🧸 Мишка", "stars": 15, "cost": "500,000"},
    "rose": {"name": "🌹 Красная роза", "stars": 25, "cost": "1,000,000"},
}


def build_keyboard(order_id: str) -> InlineKeyboardMarkup:
    keyboard = InlineKeyboardMarkup()
    keyboard.row(
        InlineKeyboardButton("✅ Одобрить", callback_data=f"approve:{order_id}"),
        InlineKeyboardButton("❌ Отклонить", callback_data=f"reject:{order_id}"),
    )
    return keyboard


def format_order_text(order: dict) -> str:
    status_map = {
        "pending": "⏳ На проверке",
        "approved": "✅ Одобрена",
        "rejected": "❌ Отклонена",
    }
    return (
        f"🎁 <b>Новая заявка на вывод #{escape(str(order['id']))}</b>\n"
        f"Статус: <b>{status_map.get(order['status'], escape(str(order['status'])))}</b>\n\n"
        f"Подарок: <b>{escape(str(order['gift_name']))}</b> "
        f"({escape(str(order['stars']))} ⭐ / {escape(str(order['cost']))})\n"
        f"Игрок: <code>{escape(str(order['playerName']))}</code>\n"
        f"Telegram: <b>{escape(str(order['recipient']))}</b>\n"
        f"Телефон: <code>{escape(str(order['phoneNumber']))}</code>"
    )


@app.route("/", methods=["GET"])
def index():
    return "Withdraw API + Telegram bot is running", 200


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "botConfigured": bool(BOT_TOKEN), "adminConfigured": bool(ADMIN_CHAT_ID)})


# Original site withdrawal endpoint: sends an admin message with approve/reject buttons.
@app.route("/api/withdraw", methods=["POST"])
def create_withdraw():
    data = request.get_json(silent=True) or {}
    gift_key = str(data.get("giftKey", "")).strip()
    player_name = str(data.get("playerName", "")).strip() or "Без имени"
    recipient = str(data.get("recipient", "")).strip()
    phone_number = str(data.get("phoneNumber", "")).strip() or "Не указан"

    if not gift_key or not recipient:
        return jsonify({"ok": False, "message": "Укажите подарок и Telegram username"}), 400
    if not ADMIN_CHAT_ID:
        return jsonify({"ok": False, "message": "ADMIN_CHAT_ID is not configured"}), 500

    gift_info = GIFTS.get(gift_key, {"name": gift_key, "stars": "?", "cost": "?"})
    order_id = uuid.uuid4().hex[:8]
    order = {
        "id": order_id,
        "giftKey": gift_key,
        "gift_name": gift_info["name"],
        "stars": gift_info["stars"],
        "cost": gift_info["cost"],
        "playerName": player_name,
        "recipient": recipient,
        "phoneNumber": phone_number,
        "status": "pending",
        "tg_message_id": None,
    }
    with orders_lock:
        orders[order_id] = order

    try:
        message = bot.send_message(
            int(ADMIN_CHAT_ID),
            format_order_text(order),
            parse_mode="HTML",
            reply_markup=build_keyboard(order_id),
        )
        with orders_lock:
            orders[order_id]["tg_message_id"] = message.message_id
    except Exception as exc:
        log.exception("Could not send withdrawal notification")
        return jsonify({"ok": False, "message": "Telegram notification failed"}), 502

    return jsonify({"ok": True, "order_id": order_id, "status": "pending"}), 200


# Optional endpoint retained from the latest SkinForge API change.
# It is not needed by the Netlify Functions setup unless a caller uses this route.
@app.route("/api/skinforge/withdrawal", methods=["POST"])
def skinforge_withdrawal():
    provided_secret = request.headers.get("X-SkinForge-Secret", "")
    if not SKINFORGE_API_SECRET or not hmac.compare_digest(provided_secret, SKINFORGE_API_SECRET):
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    if not ADMIN_CHAT_ID:
        return jsonify({"ok": False, "error": "Telegram admin is not configured"}), 500

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
    try:
        bot.send_message(int(ADMIN_CHAT_ID), message)
        return jsonify({"ok": True, "message": "Withdrawal sent"}), 200
    except Exception:
        log.exception("Could not send SkinForge withdrawal notification")
        return jsonify({"ok": False, "error": "Telegram delivery failed"}), 502


@bot.message_handler(commands=["start", "id"])
def cmd_start(message):
    bot.reply_to(
        message,
        f"Бот заявок SKINFORGE активен.\nВаш chat_id: <code>{message.chat.id}</code>",
        parse_mode="HTML",
    )


@bot.callback_query_handler(func=lambda call: bool(call.data) and call.data.startswith(("approve:", "reject:")))
def handle_decision(call):
    if ADMIN_CHAT_ID and str(call.message.chat.id) != str(ADMIN_CHAT_ID):
        bot.answer_callback_query(call.id, "Нет прав", show_alert=True)
        return

    action, order_id = call.data.split(":", 1)
    new_status = "approved" if action == "approve" else "rejected"
    with orders_lock:
        order = orders.get(order_id)
        if not order:
            bot.answer_callback_query(call.id, "Заявка не найдена", show_alert=True)
            return
        order["status"] = new_status
        updated_text = format_order_text(order)

    bot.edit_message_text(
        updated_text,
        chat_id=call.message.chat.id,
        message_id=call.message.message_id,
        parse_mode="HTML",
    )
    bot.answer_callback_query(
        call.id,
        "Заявка одобрена" if new_status == "approved" else "Заявка отклонена",
    )


def run_flask():
    port = int(os.environ.get("PORT", "10000"))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    # One Render instance only: do not start another copy of this polling bot elsewhere.
    Thread(target=run_flask, daemon=True).start()
    log.info("Starting Telegram polling")
    bot.infinity_polling(skip_pending=True)
