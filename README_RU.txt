SKINFORGE — ПОЛНЫЙ САЙТ С ОТДЕЛЬНОЙ КНОПКОЙ «ТЕСТ ЧЕК»

ВЕРСИЯ
- Основа: последняя полная версия index(6).html от 23.11.2026.
- Кнопка «✉ ТЕСТ ЧЕК» размещена прямо в верхней панели, сразу справа от «Вывод».
- Кнопка видна только после входа администратора; игрокам админская кнопка не показывается.
- Нажатие отправляет отдельное тестовое сообщение в Telegram-бот.
- Тест не создаёт заявку на подарок и не списывает баланс.
- Ограничение: один тест на проект за 24 часа, хранится в Upstash Redis.

ЧТО ЗАГРУЗИТЬ В КОРЕНЬ GITHUB
- index.html
- vercel.json
- папку api целиком (withdrawal.mjs, health.mjs, admin-auth.mjs)
- .gitignore (рекомендуется)

ПЕРЕМЕННЫЕ VERCEL → Settings → Environment Variables
TELEGRAM_BOT_TOKEN
TELEGRAM_ADMIN_CHAT_ID
SKINFORGE_ADMIN_USERNAME
SKINFORGE_ADMIN_PASSWORD
SKINFORGE_ADMIN_SESSION_SECRET (минимум 32 случайных символа)
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN

Upstash URL и токен вводятся в Vercel Environment Variables, НЕ в HTML и НЕ в открытый GitHub.
Если подключение Upstash через интеграцию Vercel создало KV_REST_API_URL и KV_REST_API_TOKEN, API тоже поддерживает эти имена.

После загрузки файлов и добавления переменных сделай Redeploy в Vercel.
Сначала войди в админ-аккаунт на сайте. После этого рядом с кнопкой «Вывод» появится отдельная кнопка «ТЕСТ ЧЕК».


ИЗМЕНЕНИЕ ЦЕНЫ МИШКИ
Цена Мишки установлена в 0 в двух местах:
- index.html — отображение цены и списание игрового баланса;
- api/withdrawal.mjs — стоимость в сообщении администратору Telegram.
Для применения загрузите оба файла в GitHub с заменой существующих и выполните Redeploy в Vercel.


Изменения: новый аккаунт получает стартовый баланс 10 000. Цена вывода подарка «Мишка» — 500 000. Цена синхронизирована в index.html и api/withdrawal.mjs.
