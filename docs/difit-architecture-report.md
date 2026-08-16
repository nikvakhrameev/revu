# difit - полный разбор архитектуры (v5.0.11)

Репозиторий выгружен в рабочую директорию сессии (`/home/claude/difit`). Разбор сделан тремя параллельными субагентами: CLI+API, бэкенд+фронтенд, хранение данных+агент-интеграции. Все пути и номера строк актуальны для клона от 2026-08-16.

## Навигация: детальные отчеты

Этот файл - сводка. Полные отчеты субагентов с номерами строк, таблицами эндпоинтов и цитатами кода лежат рядом (в проекте AI Review Tool - в папке claude/):

| Файл | Что внутри | Разделы сводки, которые он раскрывает |
|---|---|---|
| [difit-report-cli-api.md](difit-report-cli-api.md) | Все флаги и взаимоисключения CLI, резолв базы, stdin-режимы, подкоманда `difit comment`, полная спецификация каждого HTTP-эндпоинта (query/body/ответы/ошибки), SSE-события, контракт stdout построчно, `--background` handshake, env-переменные | разделы 2, 3 |
| [difit-report-backend-frontend.md](difit-report-backend-frontend.md) | Структура монорепо и все зависимости с версиями, устройство server.ts и git-diff.ts (собственный парсер диффа), file-watcher, устройство React-клиента (иерархия компонентов, хуки-сторы, вьюеры), packages/vscode как образец эмбеддинга, dev/ и scripts/ | разделы 1, 4, 5 |
| [difit-report-storage-agents.md](difit-report-storage-agents.md) | Слои хранения и форматы (DiffCommentThread, DiffContextStorage v1/v2), схема ключей localStorage, поведение при рестарте/закрытии, содержимое SKILL.md с цитатами, `difit comment` как agent API, семантика --clean, exit-коды, разбор --pr и план GitLab-интеграции | разделы 6, 7, 8 |

---

## 1. Общая структура

Лёгкий pnpm-монорепозиторий: корень (сам difit) + один пакет `packages/vscode` (VS Code расширение со вшитым difit). Node >= 21, pnpm 11.

```
src/
├── cli/        index.ts (точка входа), utils.ts, comment.ts, github.ts, background.ts
├── server/     server.ts (1122 стр., весь HTTP), git-diff.ts (парсер), file-watcher.ts, user-config.ts
├── client/     React 19 SPA: App.tsx (1608 стр.), components/ (32 шт.), viewers/, hooks/, services/
├── site/       статическое демо для GitHub Pages (staticApiBridge.ts патчит fetch - образец рендера без бэкенда!)
├── types/      diff.ts, watch.ts
└── utils/      общие: commentFormatting, commentImports, diffSelection
skills/         SKILL.md для AI-агентов (difit, difit-review)
dev/, scripts/  dev-оркестратор, перф-бенчмарки, экспорт демо-данных
```

Технологии: Express 5, simple-git, commander 15, @parcel/watcher, React 19, Vite 8, Tailwind 4, prism-react-renderer. Никакого Redux - только хуки и localStorage. Никакого octokit - GitHub через бинарь `gh` (docs/structure.md устарел и врёт про octokit).

Сборка: `tsc` (cli+server -> dist/cli, dist/server) + `vite build` (клиент -> dist/client). Бинарь: `dist/cli/index.js`.

---

## 2. CLI

### Основная команда

```
difit [commit-ish] [compare-with] [options]
```

- Позиционные: коммит/тег/ветка/HEAD~n, либо спец-аргументы `working` (unstaged), `staged`, `.` (все незакоммиченные). По умолчанию `HEAD`.
- Резолв базы (src/cli/index.ts:37-55): compare-with задан -> он база; `working` -> база `staged`; `.`/`staged` -> база `HEAD`; обычный commit -> база `<commit>^`.

### Флаги

| Флаг | Смысл |
|---|---|
| `--port` (4966), `--host` | при занятости порта авто +1 |
| `--no-open` | не открывать браузер |
| `--comment <json>` | повторяемый; предзагрузка комментариев (thread/reply) |
| `--pr <url>` | GitHub PR через `gh` |
| `--clean` | сброс комментариев (работает только через открытый браузер!) |
| `--include-untracked` | git add --intent-to-add без интерактивного вопроса |
| `--keep-alive` | не умирать при закрытии вкладки |
| `--background` | демонизация; в stdout ровно одна строка JSON `{"port":4966,"url":"...","pid":123}` |
| `--context <n>`, `--merge-base` | контекст диффа, merge-base база |

TUI-режима больше нет (удалён, CHANGELOG #346). `--mode` не существует - режим определяется из аргументов.

### stdin-режим

`diff -u a b | difit`, `git diff ... | difit`, явно `difit -`. Автодетект по fstat(0). В stdin-режиме base/target = `'stdin'`, git-операции отключены (blob, open-in-editor -> 400).

### Подкоманда `difit comment` (недокументированный agent API!)

Нет в README, есть только в CHANGELOG (#428). HTTP-клиент к уже запущенному серверу:

```
difit comment add [json] --port N        # POST /api/comment-imports; json из аргумента или stdin
difit comment get --port N [--format text|json]
difit comment resolve <threadIds...> --port N   # alias: remove
```

Это готовый двусторонний канал: агент добавляет комментарии в живой инстанс, читает ответы пользователя, резолвит треды.

### Контракт stdout (для обертки)

- Обычный запуск: строка `🚀 difit server started on http://localhost:4966` (готовый regex есть в dev/dev-stdout.js:1).
- `--background`: одна строка JSON `{port,url,pid}`.
- Завершение: при закрытии вкладки (без --keep-alive) или Ctrl+C сервер печатает блок:

```
📝 Comments from review session:
==================================================
src/foo.ts:L42
текст комментария
=====
...
==================================================
Total comments: N
```

- Exit-коды: 0 - норма, 1 - любая ошибка. Специального кода "есть/нет замечаний" нет - различать по stdout или через API.

---

## 3. HTTP API (Express 5, src/server/server.ts)

Все comment-эндпоинты принимают query `?base=&target=&baseMode=` для выбора сессии; без них - текущая активная.

| Эндпоинт | Назначение |
|---|---|
| `GET /api/diff?base&target&baseMode&ignoreWhitespace` | основной; query-параметры переключают текущую ревизию на лету; в ответе `repositoryId` (sha256 пути репо), `clearComments`, `commentImports` |
| `GET /api/revisions` | ветки, 20 последних коммитов, спец-опции |
| `GET /api/blob/*?ref=` | сырой blob файла на ревизии |
| `GET /api/line-count/*`, `GET /api/generated-status/*` | вспомогательные |
| `POST /api/comments` | полная запись тредов `{threads, baseVersion}`; при устаревшем baseVersion сервер мержит, а не перезаписывает |
| `POST /api/comment-imports` | инкрементальный импорт CommentImport[] с дедупликацией; ответ `{success, changed, count, importId, warnings}` |
| `DELETE /api/comments/:threadId` | резолв треда |
| `GET /api/comments-json` | `{version, threads}` |
| `GET /api/comments-output` | text/plain, тот же формат что stdout |
| `GET/PUT /api/user-settings` | `~/.difit/config.json` (или $DIFIT_CONFIG_DIR) |
| `POST /api/open-in-editor` | открыть файл:строку ($DIFIT_EDITOR / $EDITOR) |
| `GET /api/watch` | **SSE**: события `connected`, `reload` (файлы изменились), `error`, `commentsChanged` (version) |
| `GET /api/heartbeat` | **SSE**: детект закрытия вкладки -> через 100 мс печать комментариев и exit(0), если нет --keep-alive |

WebSocket-ов нет, всё на SSE. Аутентификации нет, биндинг localhost.

Формат комментария (CommentImport, он же для --comment и /api/comment-imports):

```json
{"type":"thread","filePath":"src/x.ts",
 "position":{"side":"new","line":42},
 "body":"текст"}
```

`line` может быть `{"start":36,"end":39}`, `side` - old/new, `type` - thread/reply, опционально id/author/createdAt/codeSnapshot. Дедупликация по id либо filePath+position+body - повторный импорт не задваивает.

---

## 4. Бэкенд: как это работает внутри

- **git**: simple-git, одна инвокация `git diff` на весь запрос (латентность на больших репо). working -> `git diff`, staged -> `--cached`, `.` -> `git diff HEAD`, пары ревизий -> revparse + diff. Собственный парсер unified diff (git-diff.ts, 873 стр.): декодер git-экранирования путей, fallback для plain `diff -u` из stdin, лимит blob 10 МБ.
- **Состояние сервера - целиком в памяти**: `commentSessions: Map<"base:target:baseMode", {threads, version}>`. Перезапуск процесса = потеря всего. Единственный файл на диске - `~/.difit/config.json` (UI-настройки).
- **Оптимистичная конкуренция**: у каждой сессии `version`; клиент шлет `baseVersion`, при расхождении сервер мержит (специально ради сценария "агент пишет пока браузер открыт"). Любое изменение рассылает SSE `commentsChanged`.
- **Live-reload**: @parcel/watcher (ленивый импорт, деградирует без нативного бинарника), пути слежения зависят от DiffMode, дебаунс 300 мс, .gitignore через `git check-ignore`, из .git смотрятся только HEAD/index. Для сравнения двух конкретных ревизий watching выключен.
- **Жизненный цикл**: браузер держит SSE /api/heartbeat; разрыв (без --keep-alive) -> печать комментариев в stdout -> exit(0). Это и есть штатная "блокировка ожидания агента".
- **Программный запуск**: `startServer(options)` экспортируется и используется VS Code расширением напрямую (fork + IPC `{type:'ready', url, port}`) - готовый шаблон эмбеддинга без CLI.

---

## 5. Фронтенд

React 19 SPA, App.tsx - god component со всем стейтом. Рендер: DiffViewer -> реестр вьюеров (Text/Markdown+Mermaid/Notebook/Image, расширяемый registry.ts) -> DiffChunk (unified) / SideBySideDiffChunk (split). Prism-подсветка с динамической подгрузкой языков, word-level diff, подсветка слова под курсором. Комментарии: CommentButton -> CommentForm -> CommentThreadCard (треды, реплаи, markdown, suggestion-блоки). Хоткеи j/k/v, Shift+C (copy all prompt). Viewed-статус файлов с SHA-256 хешем диффа ("changed since viewed"). Общение с бэком - голый fetch + два EventSource, реконнект SSE до 5 попыток.

---

## 6. Хранение данных (критично для пункта 2 нашего проекта)

Два слоя, **ни один не персистит комментарии на диск**:

1. **localStorage браузера** (основной): ключ `difit-storage-v1/{repositoryId}/{base}-{target}[-merge-base]`, где repositoryId = sha256 абсолютного пути git-root. Внутри `DiffContextStorage v2`: threads, viewedFiles (с хешами диффов), appliedCommentImportIds.
2. **Map в памяти сервера**: живет до конца процесса. После рестарта клиент сам заливает треды из localStorage обратно (bootstrap merge в App.tsx:904-972).

Следствия и ограничения:

- Привязка к **паре ревизий, не к ветке/задаче**. Ветки нормализуются в хеш коммита -> новый коммит в ветке = другой ключ = комментарии "уезжают". Понятия "сессия ревью по задаче" нет.
- localStorage привязан к origin `http://localhost:PORT` -> **другой порт = комментарии не видны**. (Именно поэтому UI-настройки вынесли в ~/.difit/config.json в 5.0.9.)
- В stdin/PR-режиме ключ всегда `stdin-stdin` -> все MR делят одно хранилище в браузере.
- Нет истории/архива ревью, нет экспорта/импорта из файла.
- `--clean` работает только через открытый браузер (сервер лишь прокидывает флаг clearComments в /api/diff); импортированные через --comment комментарии переживают clean.

**Вывод для обертки: персистентность по бранчу/задаче придется строить самим** - снимать состояние через `difit comment get --format json` (или GET /api/comments-json), хранить у себя (файл в разрезе ветки/задачи), заливать при старте через `--comment` или `comment add`. Формат CommentImport с собственными id дает идемпотентность.

---

## 7. Интеграция с AI-агентами

- **MCP-сервера нет.** Вся интеграция = CLI + HTTP API + skill-файлы.
- **Skills** (`skills/difit/SKILL.md`, `skills/difit-review/SKILL.md`, установка `npx skills add yoshiko-pg/difit`): рецепты для агента - запустить difit с предзагруженными `--comment`, ждать выхода процесса, комментарии пользователя придут в stdout; "Client disconnected без комментариев = замечаний нет, не перезапускать". Security-guardrail: не копировать секреты из диффа в тела комментариев.
- **Штатный блокирующий режим**: агент запускает difit в foreground, процесс живет пока открыта вкладка, при закрытии комментарии печатаются в stdout и процесс выходит.
- **Неблокирующий**: `--background` (JSON с port/pid) + `difit comment get/add/resolve --port N` + SSE `/api/watch` (событие `commentsChanged` при любой правке, включая правки из UI).
- Хуков/плагинов/webhook-ов нет. Точки расширения: comment-imports API, SSE watch, stdout-парсинг, программный startServer(), эмуляция fetch как в src/site/staticApiBridge.ts.

---

## 8. GitHub PR и GitLab

- `--pr`: патч через `execFileSync('gh', ['pr','diff',url])`, скармливается как stdin-дифф; нерешённые inline-треды PR тянутся через `gh api graphql` (пагинация по 100) и конвертируются в CommentImport (resolved/outdated/не-LINE отфильтровываются). GHE работает (hostname из URL). Обратно в GitHub ничего не публикуется - скилл это явно запрещает.
- **GitLab: 0 упоминаний в коде.** Никакой абстракции провайдера - --pr жестко завязан на `gh`.

Естественный путь GitLab-интеграции для обертки (пункт 4 проекта):

1. Патч: `glab mr diff <iid>` или REST `/projects/:id/merge_requests/:iid/raw_diffs` -> подать через stdin (`... | difit -`) - полностью поддерживаемый путь.
2. Дискуссии MR -> сконвертировать в CommentImport[] (id = id заметки GitLab -> дедупликация при повторных синках) -> `--comment` при старте или `comment add` в рантайме.
3. Обратная синхронизация difit -> GitLab: `difit comment get --format json` + после публикации `comment resolve <threadId>`.
4. Учесть: в stdin-режиме все MR делят localStorage-ключ `stdin-stdin` -> либо порт на MR, либо состояние держать у себя.

---

## 9. Готовые рычаги под каждый пункт нашего проекта

| Пункт проекта | Что дает difit | Что строить самим |
|---|---|---|
| 1. Интеграция с claude code | skills, --comment, comment add/get/resolve, stdout-контракт, exit по закрытию вкладки | оркестрацию сессий, свой skill/MCP поверх |
| 2. Стейт по бранчу/задаче | GET /api/comments-json, comment get --format json, CommentImport с id (идемпотентный импорт) | всю персистентность: файлы состояния в разрезе ветки/задачи, снятие снапшотов (poll version или SSE commentsChanged) |
| 3. Рендер локальных MR | difit A B, --merge-base, stdin-режим, смена ревизий на лету через /api/diff?base&target | список MR, маппинг MR -> ревизии |
| 4. GitLab-синк | stdin-дифф + comment-imports API (формат готов) | весь GitLab-клиент (glab/REST), конвертация дискуссий, обратную публикацию |
| 5. CLI-блокировка ожидания | foreground-режим (exit при закрытии вкладки + комментарии в stdout), --keep-alive, --background {port,pid} | ожидание "агент закончил + пользователь отревьюил" поверх SSE/poll |

Риски/грабли: комментарии теряются при смене порта и новом коммите в ветке; нет спец. exit-кодов; --clean требует браузера; docs/structure.md устарел (не верить ему); README умалчивает про `difit comment`.
