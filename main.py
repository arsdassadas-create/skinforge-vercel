from pathlib import Path
import shutil, subprocess, sys

DESKTOP = Path.home() / "Desktop"
HTML_NAME = "SKINFORGE_NOVA_VIOLET_ACCOUNT_ADMIN_MENU_ONLY.html"
source = Path(__file__).with_name(HTML_NAME)
if not source.exists():
    print(f"Не найден {HTML_NAME}. Положи HTML рядом с этим PY-файлом.")
    input("Enter для выхода...")
    raise SystemExit(1)

candidates = [
    DESKTOP / "SKINFORGE_NETLIFY_READY_2",
    DESKTOP / "SKINFORGE_NETLIFY_READY",
]
projects = [p for p in candidates if (p / "site" / "index.html").exists() and (p / "netlify.toml").exists()]
if not projects:
    for p in DESKTOP.glob("**/site/index.html"):
        root = p.parent.parent
        if (root / "netlify.toml").exists() and (root / "netlify/functions/admin-auth.mjs").exists():
            projects.append(root)
if not projects:
    print("Не нашёл папку проекта Netlify.")
    print("Нужна папка, внутри которой есть site/index.html и netlify.toml.")
    input("Enter для выхода...")
    raise SystemExit(1)

project = max(projects, key=lambda p: (p / "site" / "index.html").stat().st_mtime)
target = project / "site" / "index.html"
backup = target.with_name("index.before-admin-account-menu.html")
shutil.copy2(target, backup)
shutil.copy2(source, target)
print("Обновлён файл:", target)
print("Резервная копия:", backup)
if not (project / "netlify/functions/admin-auth.mjs").exists():
    print("ВНИМАНИЕ: не найден admin-auth.mjs. Возьми его из ZIP-проекта и положи в netlify/functions.")
    input("Enter для выхода...")
    raise SystemExit(1)

answer = input("Сразу опубликовать на skinforge67? [Y/n]: ").strip().lower()
if answer in ("", "y", "yes", "д", "да"):
    cmd = ["netlify", "deploy", "--dir=site", "--functions=netlify/functions", "--prod", "--no-build"]
    try:
        result = subprocess.run(cmd, cwd=project)
    except FileNotFoundError:
        print("Netlify CLI не найден. Установи: npm install -g netlify-cli")
        input("Enter для выхода...")
        raise SystemExit(1)
    if result.returncode != 0:
        print("Деплой завершился с ошибкой. Файлы обновлены, старый deploy остаётся активным.")
        input("Enter для выхода...")
        raise SystemExit(result.returncode)
print("Готово. Если не запускал публикацию, открой папку проекта и запусти DEPLOY_TO_NETLIFY.bat.")
input("Enter для выхода...")
