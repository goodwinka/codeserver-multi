# code-server · multi-user

Многопользовательская обёртка вокруг [code-server](https://github.com/coder/code-server):
один Docker-контейнер, auth-прокси на Node.js, отдельный процесс code-server
на каждого пользователя, общие установленные расширения и веб-панель
администрирования.

```
            :8080 (HTTP/WS)
                │
        ┌───────┴────────┐
        │  Auth-прокси   │  /_auth/login · /_auth/account · /_auth/admin
        │   (Node.js)    │  остальное → персональный code-server
        └────┬────┬─────┬┘
             ▼    ▼     ▼
         ┌──────┬──────┬──────┐
         │ cs:  │ cs:  │ cs:  │   по одному процессу code-server
         │alice │ bob  │carol │   на пользователя (127.0.0.1:81xx)
         └──────┴──────┴──────┘
             │    │     │
     /users/alice  /users/bob  /users/carol     ← bind-mount c хоста
             │
     /opt/shared-extensions   ← общие плагины для всех
```

## Возможности

- ✅ Один контейнер, один внешний порт
- ✅ Вход по логину/паролю (bcrypt), сессии через HttpOnly cookie
- ✅ Персональный процесс code-server на пользователя (изоляция настроек и истории)
- ✅ Файлы пользователя — в `./users/<name>/` на хосте
- ✅ Общие расширения: `/opt/shared-extensions`, ставятся через админку или JSON
- ✅ Админ-панель: CRUD пользователей, сброс пароля, отключение, список запущенных экземпляров, установка плагинов
- ✅ Страница аккаунта: смена пароля, выход / смена пользователя
- ✅ Авто-остановка простаивающих экземпляров (по умолчанию через 1 час)
- ✅ Корректный проксинг WebSocket (терминал VS Code работает)

## Быстрый старт

```bash
# 1. Распакуйте архив и зайдите в папку
cd codeserver-multi

# 2. Создайте папку для пользовательских файлов и конфигов
mkdir -p users config

# 3. ВАЖНО: отредактируйте docker-compose.yml
#    - замените SESSION_SECRET на что-то длинное и случайное
#    - поменяйте BOOTSTRAP_ADMIN_PASSWORD

# 4. Соберите и запустите
docker compose build
docker compose up -d

# 5. Смотрим логи
docker compose logs -f
```

Откройте `http://<host>:8080` → попадёте на страницу входа.

Войдите под `admin` (пароль — из `BOOTSTRAP_ADMIN_PASSWORD`) и создайте
пользователей в админ-панели (`/_auth/admin`).

## Страницы

| Путь              | Кто  | Назначение                                         |
|-------------------|------|----------------------------------------------------|
| `/`               | все  | Личный редактор VS Code                            |
| `/_auth/login`    | —    | Страница входа                                     |
| `/_auth/account`  | все  | Профиль, смена пароля, выход / смена пользователя |
| `/_auth/admin`    | admin| Админ-панель (пользователи / экземпляры / плагины)|

## Что где хранится

| Путь на хосте               | Что это                                   |
|-----------------------------|-------------------------------------------|
| `./users/<name>/`           | Домашняя папка пользователя               |
| `./users/<name>/.local/share/code-server/` | Настройки его code-server    |
| `./config/users.json`       | БД пользователей (bcrypt-хеши)            |
| `./config/extensions.json`  | Стартовый список общих расширений         |
| `./config/sessions/`        | Серверные сессии express-session          |
| volume `shared-extensions`  | `/opt/shared-extensions` — общие плагины  |

## Переменные окружения

| Имя                       | Описание                                              |
|---------------------------|-------------------------------------------------------|
| `SESSION_SECRET`          | **Обязательно** смените. Секрет для подписи сессий.   |
| `SESSION_COOKIE_NAME`     | Имя cookie сессии (default: `cs_sid`)                 |
| `BOOTSTRAP_ADMIN_USER`    | Имя стартового админа                                 |
| `BOOTSTRAP_ADMIN_PASSWORD`| Пароль стартового админа (создаётся только если админов ещё нет) |
| `IDLE_TIMEOUT_MS`         | Через сколько мс простоя гасить code-server (1 ч)     |
| `USERS_ROOT`              | Корень пользовательских домашних папок (`/users`)     |
| `SHARED_EXT_DIR`          | Каталог общих расширений (`/opt/shared-extensions`)   |

## Установка общих расширений

### Через админ-панель

`/_auth/admin` → вкладка «Расширения» → вводишь `publisher.name` или
`publisher.name@1.2.3` → «Установить».

### Через JSON при первом запуске

Отредактируй `config/extensions.json` **до первого запуска**
(пока `/opt/shared-extensions` пуст):

```json
{
  "extensions": [
    "esbenp.prettier-vscode",
    "ms-python.python",
    "eamodio.gitlens",
    "dbaeumer.vscode-eslint"
  ]
}
```

### Из `.vsix`-файла

Положи файл в `./users/admin/` (или любую смонтированную папку), зайди
как admin в `/_auth/admin` → «Расширения» → введи **абсолютный путь**
внутри контейнера: `/users/admin/my-ext.vsix` → «Установить».

## HTTPS в продакшене

1. Поставь перед прокси nginx / Caddy / Traefik с сертификатом.
2. В `auth-proxy/server.js` в `sessionMiddleware` раскомментируй
   `cookie.secure = true`.
3. В nginx обязательно включи проксирование WebSocket:
   ```nginx
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   proxy_set_header Host $host;
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_read_timeout 7d;
   ```

## Ограничения и дальнейшая работа

- **Изоляция по UID не настроена.** Все процессы code-server работают
  под одним пользователем контейнера. Для настоящей изоляции прав файлов
  нужно создавать unix-пользователей и запускать каждый code-server через
  `gosu/su-exec` — это доработка.
- **Один контейнер** — значит падение прокси завершает все сессии.
  Для HA разверни 2+ контейнера за балансировщиком со sticky-sessions
  и общим session store (Redis).
- **Marketplace**. Код ставит расширения стандартным CLI code-server,
  который использует Open VSX (`open-vsx.org`). Если нужен Microsoft
  Marketplace — настрой `EXTENSIONS_GALLERY` или используй `.vsix`.
- **Квоты CPU/RAM на пользователя** — не реализованы; можно прикрутить
  через cgroups или переехать на контейнер-на-пользователя.

## Структура проекта

```
codeserver-multi/
├── Dockerfile
├── docker-compose.yml
├── README.md
├── auth-proxy/
│   ├── package.json
│   ├── server.js              # Express + http-proxy + session
│   ├── users.js               # хранилище пользователей
│   ├── instances.js           # менеджер процессов code-server
│   ├── extensions.js          # обёртка над code-server CLI
│   ├── admin-api.js           # REST /_auth/api
│   └── public/
│       ├── login.html
│       ├── account.html
│       └── admin.html
├── scripts/
│   ├── entrypoint.sh
│   └── install-extensions.sh
└── config/
    ├── users.json             # будет заполнен при создании пользователей
    └── extensions.json        # стартовый список общих плагинов
```

## Типовые операции

**Посмотреть, кто сейчас работает:** `/_auth/admin` → вкладка «Экземпляры».

**Сбросить пароль пользователю:** `/_auth/admin` → «Пользователи» →
кнопка «Сменить пароль».

**Временно заблокировать пользователя:** «Отключить» в списке пользователей.
Активная сессия будет прервана, вход запрещён.

**Забыл пароль админа:** отредактируй `config/users.json` на хосте,
удали админа, перезапусти контейнер — он пересоздастся из `BOOTSTRAP_*`.

**Обновить code-server:** пересобрать образ: `docker compose build --no-cache`.

## Лицензия

Делай с кодом что хочешь. code-server — MIT, остальное — тоже MIT.
