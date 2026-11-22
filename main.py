import os
import uuid
from threading import Thread, Lock
from flask import Flask, request, jsonify
from flask_cors import CORS
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

BOT_TOKEN = (os.environ.get("BOT_TOKEN") or "8955553619:AAEav3ERKNmTUtygHzqfWW4LazWmiMDKbow").strip()
ADMIN_CHAT_ID = (os.environ.get("ADMIN_CHAT_ID") or "8998213268").strip()

if not BOT_TOKEN:
    raise RuntimeError("Не задан BOT_TOKEN в Environment Variables")

bot = telebot.TeleBot(BOT_TOKEN)
app = Flask(__name__)
CORS(app)

orders = {}
orders_lock = Lock()


def build_keyboard(order_id: str) -> InlineKeyboardMarkup:
    kb = InlineKeyboardMarkup()
    kb.row(
        InlineKeyboardButton("✅ Одобрить", callback_data=f"approve:{order_id}"),
        InlineKeyboardButton("❌ Отклонить", callback_data=f"reject:{order_id}"),
    )
    return kb


def format_order_text(order: dict) -> str:
    status_map = {
        "pending": "⏳ На проверке",
        "approved": "✅ Одобрена",
        "rejected": "❌ Отклонена",
    }
    return (
        f"💸 <b>Заявка на вывод #{order['id']}</b>\n"
        f"Статус: <b>{status_map.get(order['status'], order['status'])}</b>\n"
        f"Пользователь: <code>{order['user']}</code>\n"
        f"Сумма: <b>{order['amount']}</b>\n"
        f"Реквизиты: <code>{order['requisites']}</code>"
    )


@app.route("/", methods=["GET"])
def index():
    return "Withdraw API + Bot is running", 200


@app.route("/api/withdraw", methods=["POST"])
def create_withdraw():
    data = request.get_json(silent=True) or {}
    user = str(data.get("user", "")).strip()
    amount = str(data.get("amount", "")).strip()
    requisites = str(data.get("requisites", "")).strip()

    if not user or not amount or not requisites:
        return jsonify({"ok": False, "error": "Заполните user, amount и requisites"}), 400

    order_id = uuid.uuid4().hex[:8]
    order = {
        "id": order_id,
        "user": user,
        "amount": amount,
        "requisites": requisites,
        "status": "pending",
        "tg_message_id": None,
    }

    with orders_lock:
        orders[order_id] = order

    if ADMIN_CHAT_ID:
        try:
            msg = bot.send_message(
                int(ADMIN_CHAT_ID),
                format_order_text(order),
                parse_mode="HTML",
                reply_markup=build_keyboard(order_id),
            )
            with orders_lock:
                orders[order_id]["tg_message_id"] = msg.message_id
        except Exception as e:
            return jsonify({"ok": False, "error": f"Ошибка отправки в Telegram: {e}"}), 500

    return jsonify({"ok": True, "order_id": order_id, "status": "pending"}), 201


@app.route("/api/withdraw/<order_id>", methods=["GET"])
def get_withdraw_status(order_id):
    with orders_lock:
        order = orders.get(order_id)
    if not order:
        return jsonify({"ok": False, "error": "Заявка не найдена"}), 404
    return jsonify({
        "ok": True,
        "order_id": order["id"],
        "status": order["status"],
        "amount": order["amount"],
    }), 200


@bot.message_handler(commands=["start", "id"])
def cmd_start(message):
    bot.reply_to(
        message,
        f"Бот заявок активен.\nВаш chat_id: <code>{message.chat.id}</code>",
        parse_mode="HTML",
    )


@bot.callback_query_handler(func=lambda call: call.data.startswith(("approve:", "reject:")))
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
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)


if __name__ == "__main__":
    Thread(target=run_flask, daemon=True).start()
    bot.infinity_polling(skip_pending=True)
