# difit - детальный разбор: CLI и HTTP API

Отчет субагента (зона: CLI и HTTP API). Репозиторий `/home/claude/difit`, версия 5.0.11. Часть серии разборов, сводный файл: `difit-architecture-report.md`.

---

## 1. CLI

### 1.1 Точка входа

- `package.json:33-35` - `"bin": { "difit": "./dist/cli/index.js" }`, также `"main": "./dist/cli/index.js"`, `"type": "module"`.
- Исходник: `src/cli/index.ts` (шебанг `#!/usr/bin/env node`, строка 1). Компилируется `tsc --project tsconfig.cli.json` в `dist/cli/`.
- Парсер: **commander v15** (`src/cli/index.ts:3`, `95` - `const program = new Command()`), `void program.parseAsync()` на строке 357.
- `engines.node >= 21.0.0` (`package.json`).

### 1.2 Основная команда и позиционные аргументы

`src/cli/index.ts:97-131`:

| Что | Строка | Детали |
|---|---|---|
| `.name('difit')` | 98 | |
| `.version(pkg.version, '-v, --version')` | 100 | |
| `.enablePositionalOptions()` | 101 | опции после подкоманды принадлежат подкоманде |
| `[commit-ish]` | 103-107 | default `'HEAD'`; «Git commit, tag, branch, HEAD~n reference, or "working"/"staged"/"."» |
| `[compare-with]` | 108-111 | второй ревиж для сравнения |

Спец-аргументы (`SpecialArg = 'working' | 'staged' | '.'`, `src/cli/index.ts:31-35`).

**Резолв базы** - `resolveDiffSelection()` (`src/cli/index.ts:37-55`):
- есть `compare-with` -> база = он;
- `working` -> база `staged`;
- `.` / `staged` -> база `HEAD`;
- иначе (обычный commit-ish) -> база `<commitish>^`;
- при `--merge-base` в `DiffSelection.baseMode` кладется `'merge-base'` (`src/utils/diffSelection.ts:7-24`).

**Валидация** - `validateDiffArguments()` (`src/cli/utils.ts:178-224`):
- спец-аргументы допустимы только как target, исключение - `working` vs `staged`;
- `target === base` запрещено;
- `working` можно сравнивать только со `staged` (иначе подсказка использовать `.`);
- формат commit-ish: `validateCommitish()` (`src/cli/utils.ts:62-83`), SHA 4-40 hex, `HEAD`, `@`, суффиксы `^`/`~N` срезаются (`stripRevisionSuffix`, 100-134), имена веток по git-правилам (`isValidBranchName`, 140-164).

**Режим слежения** - `determineDiffMode()` (`src/cli/index.ts:57-79`) -> enum `DiffMode` (`src/types/watch.ts:1-7`): `default | working | staged | dot | specific`. `specific` = сравнение двух конкретных ревизий -> file watching выключен.

### 1.3 Опции (флаги) корневой команды

`src/cli/index.ts:112-130`, интерфейс `CliOptions` - `src/cli/index.ts:81-93`:

| Флаг | Строка | Default | Поведение |
|---|---|---|---|
| `--port <port>` | 112 | `4966` (задается в server.ts:1052) | `parseInt`; при занятости порт +1 рекурсивно |
| `--host <host>` | 113 | `''` -> `'localhost'` (server.ts:1053) | README указывает 127.0.0.1; при host != localhost/127.0.0.1 печатается warning (server.ts:1057-1061) |
| `--no-open` | 114 | `options.open === true` по умолчанию | не открывать браузер |
| `--comment <json>` | 115-120 | `[]` | повторяемый; JSON-объект или массив; аккумулируется в массив строк |
| `--pr <url>` | 121 | - | GitHub PR URL |
| `--clean` | 122 | false | очистить существующие комментарии |
| `--include-untracked` | 123 | false | авто-`git add --intent-to-add` для untracked |
| `--keep-alive` | 124 | false | сервер живет после отключения браузера |
| `--background` | 125 | false | демонизировать и выдать JSON `{port,url,pid}` в stdout |
| `--context <lines>` | 126 | git default (3) | `parseInt`, передается как `-U<N>` в git diff |
| `--merge-base` | 127-130 | false | `git merge-base` для базы |
| `-v, --version` | 100 | | |

**Взаимоисключения** (все -> `console.error` + `process.exit(1)`):
- `--context` < 0 или не целое -> `src/cli/index.ts:140-146`;
- `--pr` + позиционные аргументы -> 168-172;
- `--pr` + `--merge-base` -> 174-177;
- `--pr` + `--context` -> 179-182;
- stdin + `--context` -> 211-214; stdin + `--merge-base` -> 215-218;
- `--merge-base` когда резолвнутая база оказалась спец-аргументом -> 268-273.

**TUI отсутствует** - удален, см. `CHANGELOG.md:189` («Remove TUI mode and related code (#346)»), ранее deprecated `CHANGELOG.md:293`. Опции `--mode` в CLI **нет** (режим определяется автоматически из аргументов). Опции `--ignore-whitespace` в CLI **нет** - только серверная опция `ignoreWhitespace` и query-параметр `/api/diff?ignoreWhitespace=true`.

### 1.4 Подкоманда `difit comment`

`src/cli/comment.ts:40-182`, регистрация - `src/cli/index.ts:102` (`.addCommand(createCommentCommand())`). Все подкоманды работают по HTTP с уже запущенным сервером на `http://localhost:<port>`.

| Команда | Строки | Аргументы/опции | Что делает | stdout |
|---|---|---|---|---|
| `difit comment add [json]` | 45-81 | `--port <port>` (**required**), `[json]`; если json не передан - читается из **stdin** (`parseCommentAddInput`, 23-38; если stdin - tty, ошибка) | `POST /api/comment-imports` | JSON `{success, importId, count, warnings}` |
| `difit comment get` | 83-112 | `--port` (required), `--format <text\|json>` (default `text`) | `GET /api/comments-output` (text) или `GET /api/comments-json` (json) | текст промпта либо JSON |
| `difit comment resolve <threadIds...>` (alias `remove`) | 114-179 | `--port` (required) | по `DELETE /api/comments/:threadId` на каждый id (параллельно) | JSON `{success, resolved[], notFound[], errors[]}`; exit 1 если что-то не найдено/ошибка |

Ошибка соединения -> `Error: Cannot connect to difit server on port <port>. Is the server running?` (`src/cli/comment.ts:14-21`).

### 1.5 Stdin-режимы

Логика выбора - `shouldReadStdin()` (`src/cli/utils.ts:30-48`), вызов - `src/cli/index.ts:204-225`:
1. `commitish === '-'` -> stdin принудительно (`utils.ts:38-40`);
2. если есть позиционные аргументы (`program.args.length > 0`) или `--pr` -> git/PR-режим, stdin не читается (`utils.ts:42-44`);
3. иначе автодетект по `fstatSync(0)`: `pipe | file | socket` -> stdin; `tty` -> нет (`detectStdinSource`, `utils.ts:14-28`).

Чтение - `readStdin()` (`utils.ts:250-256`), пустой ввод -> `Error: No diff content received from stdin` (`index.ts:221-224`).
Диф из stdin парсится `parser.parseStdinDiff()` (`src/server/server.ts:174`). В stdin-режиме `baseCommitish/targetCommitish` = `'stdin'` (server.ts:112-114, 345-353).

Примеры из README (`README.md:117-140`):
```bash
diff -u file1.txt file2.txt | difit
cat changes.patch | difit
git diff --merge-base main feature | difit
git diff -- /dev/null path/to/file | difit    # весь файл как новый
git diff --cached | difit -                    # явный stdin-режим
```

### 1.6 Режим `--pr`

`src/cli/index.ts:168-201` -> `src/cli/github.ts`:
- патч: `execFileSync('gh', ['pr', 'diff', prArg])` (`github.ts:329-344`). **Расхождение с README** (`README.md:85` заявляет `gh pr diff --patch`, реально `--patch` не передается);
- нерешенные inline-треды PR: `gh api graphql --hostname <host> -f query=...` с пагинацией по 100 (`github.ts:72-109`, `376-436`), парсинг URL - `parseGitHubPrUrl` (306-327);
- фильтрация: пропускаются `isResolved`, `isOutdated`, `subjectType !== 'LINE'` (`github.ts:234`);
- PR-комментарии идут **перед** ручными `--comment`: `commentImports = [...prCommentImports, ...manualCommentImports]` (`index.ts:196`);
- сбой загрузки комментариев PR -> только `console.warn`, запуск продолжается (`index.ts:197-201`).

### 1.7 Формат `--comment` (JSON)

Типы - `src/types/diff.ts:126-145` (`ThreadCommentImport | ReplyCommentImport`), нормализация/валидация - `src/utils/commentImports.ts:121-169`:

```json
{"type":"thread"|"reply",
 "id":"опц. строка",
 "filePath":"src/x.ts",
 "position":{"side":"old"|"new",
             "line": 42 | {"start":36,"end":39}},
 "body":"текст",
 "author":"опц.",
 "createdAt":"ISO8601 опц.","updatedAt":"ISO8601 опц.",
 "codeSnapshot":{"content":"...","language":"опц."}}
```
- `filePath` обязателен, непустой; `body` обязателен, trim, непустой; `line` - целые > 0, start<=end.
Ошибки вида `Invalid comment import field: <field>` / `Invalid --comment JSON` (`commentImports.ts:160-169`).
Дедупликация: одинаковый thread (по id либо filePath+position+root message) пропускается; `reply` привязывается к самому свежему треду в той же позиции, иначе warning `Skipped reply import for ...` (`commentImports.ts:480-532`).

### 1.8 Untracked-файлы

`handleUntrackedFiles()` (`src/cli/index.ts:359-386`), вызывается только для target `working` или `.` (`index.ts:275-282`). Без `--include-untracked` - интерактивный вопрос `promptUser` (`utils.ts:236-248`, ответ пустой/`y`/`yes` = да). В background-child режиме интерактив пропускается (`index.ts:277-279`). Добавление: `git add --intent-to-add` (`utils.ts:232-234`), печатает подсказку отката `git reset -- <files>`.

### 1.9 Примеры из README (`README.md:44-158`)

```bash
npx difit                                # HEAD
difit 6f4a9b7 / difit feature            # конкретный коммит / ветка
difit @ main | difit feature main | difit . origin/main
difit . | difit staged | difit working
difit --pr https://github.com/owner/repo/pull/123
difit --comment '{"type":"thread","filePath":"src/example.ts","position":{"side":"new","line":10},"body":"..."}'
difit . --include-untracked
```
Skills для агентов: `skills/difit/SKILL.md`, `skills/difit-review/SKILL.md` (устанавливаются `npx skills add yoshiko-pg/difit`) - там канонические рецепты запуска из агента с `--comment`.

---

## 2. HTTP API бэкенда

Файл: `src/server/server.ts`, экспорт `startServer(options): Promise<{port, url, isEmpty?, server?}>` (строка 124). Express 5. Middleware: `express.json()` (152), `express.text()` для `sendBeacon` (153), CORS-заголовки (155-160): `Access-Control-Allow-Origin: http://localhost:*`, методы `GET, POST, PUT, DELETE, OPTIONS`.

### 2.1 Diff и файловые данные

**`GET /api/diff`** - `server.ts:293-370`
- Query: `ignoreWhitespace=true|false`, `base=<commitish>`, `target=<commitish>`, `baseMode=merge-base` (иные значения -> undefined, `parseBaseMode` 144-150).
- Query-параметры **переключают** текущий выбор на сервере: `currentSelection = requestedSelection` (336) и `currentCommentSelection` (338). Т.е. клиент может менять ревизии на лету.
- Кеш LRU на 8 записей, ключ `base:target:baseMode\0ignoreWhitespace` (`server.ts:64-99`, `createDiffCacheKey` 67).
- Ответ (`DiffResponse`, `src/types/diff.ts:49-64`) + доп. поля (356-369):
```jsonc
{"commit":"abc1234...def5678", "files":[DiffFile...], "isEmpty":bool,
 "ignoreWhitespace":bool, "openInEditorAvailable":bool,     // false для stdin
 "baseCommitish":"...", "targetCommitish":"...",             // резолвнутые (short hash)
 "requestedBaseCommitish":"...", "requestedTargetCommitish":"...", "requestedBaseMode":"merge-base"|undefined,
 "clearComments":bool,                                        // из --clean
 "repositoryId":"<sha256 от абсолютного пути репо>",          // server.ts:129
 "commentImports":[...], "commentImportId":"<sha256>"}        // только для стартовой selection
```
- Ошибка парсинга -> `500 {error}` (326-329). Для stdin всегда возвращается `initialDiffData`.
- `DiffFile`: `{path, oldPath?, status: modified|added|deleted|renamed, additions, deletions, chunks[], isGenerated?}` (`src/types/diff.ts:1-25`).

**`GET /api/revisions`** - `server.ts:414-445`. Без параметров. 400 для stdin. Ответ `RevisionsResponse` (`src/types/diff.ts:219-226`): `specialOptions` (`.` / `staged` / `working`), `branches[{name,current}]`, `commits[{hash,shortHash,message}]`, `originDefaultBranch?`, `resolvedBase?`, `resolvedTarget?`. Ошибка -> 500.

**`GET /api/blob/*`** - `server.ts:495-542` (regex-роут `^/api/blob/(.*)$`). Query `ref` (default `HEAD`). Возвращает сырые байты, Content-Type по расширению (список image-типов 515-529, иначе `application/octet-stream`), `Cache-Control: no-cache...`. 404 для stdin и для отсутствующего файла.

**`GET /api/line-count/*`** - `server.ts:447-493`. Query `oldRef`, `newRef`, `oldPath`. Ответ `{oldLineCount?, newLineCount?}` (при ошибке конкретного ref - 0). 404 для stdin, 400 при плохом пути.

**`GET /api/generated-status/*`** - `server.ts:372-411`. Query `ref` (default = текущий target или `HEAD`). Ответ `{path, ref, isGenerated, source: 'path'|'content'}`. Кеш TTL 60 c (`GENERATED_STATUS_CACHE_TTL_MS`, строка 64). 400 для stdin.

Все путевые роуты защищены `parseRepositoryRelativePath()` (`server.ts:203-225`): абсолютные пути, `..` и выход за пределы репозитория -> `400 {error: 'Invalid file path' | 'File path outside repository'}`.

### 2.2 Комментарии

Ключевая абстракция - **comment session** на пару ревизий: `commentSessions: Map<key, {threads, version}>`, ключ = `base:target:baseMode` (`server.ts:120-122`, `249-291`, `getDiffSelectionKey` в `src/utils/diffSelection.ts:37-39`). Все comment-эндпоинты принимают одинаковые query-параметры **`base`, `target`, `baseMode`** (`getCommentSelectionFromQuery`, `server.ts:258-276`); если ни один не задан - используется текущая сессия `currentCommentSelection`. Клиент всегда шлет `base`+`target` (см. `src/client/App.tsx:215-238`).

| Эндпоинт | Строки | Тело запроса | Ответ |
|---|---|---|---|
| **`GET /api/comments-json`** | 808-815 | - | `{version:number, threads: DiffCommentThread[]}` |
| **`GET /api/comments-output`** | 817-828 | - | `text/plain`, человекочитаемый промпт (пустая строка если нет тредов) |
| **`POST /api/comments`** | 734-762 | `{threads: CommentThread[]\|DiffCommentThread[], baseVersion?: number}` либо legacy `{comments: Comment[]}`; принимается и `text/plain` (sendBeacon) | `{success:true, merged:bool, version:number, threads:[...]}`; 400 `{error:'Invalid comment data'}` |
| **`POST /api/comment-imports`** | 764-786 | `CommentImport` или массив (тот же формат, что `--comment`); допускается text/plain | `{success:true, changed:bool, count:number, importId:sha256, warnings:string[]}`; 400 `{error:'Invalid comment import data'}` |
| **`DELETE /api/comments/:threadId`** | 788-806 | - | `{success:true, threadId, version}`; 404 `{error:'Thread not found: <id>'}` |

Оптимистическая конкуренция: если клиент прислал `baseVersion`, не равный серверному `session.version`, - вместо перезаписи выполняется merge (`server.ts:743-750`, `mergeCommentThreads` в `src/utils/commentImports.ts:429-446`), в ответе `merged:true`. Любое реальное изменение инкрементит `version` и **рассылает SSE-событие** `{type:'commentsChanged', version, timestamp}` всем подписчикам `/api/watch` (`updateCommentSession`, `server.ts:712-732`).

Структура `DiffCommentThread` - `src/types/diff.ts:113-124`: `{id, filePath, createdAt, updatedAt, position:{side, line: number|{start,end}}, codeSnapshot?:{content, language?}, messages:[{id, body, author?, createdAt, updatedAt}]}`.

### 2.3 SSE (WebSocket-ов нет)

**`GET /api/watch`** - `server.ts:969-982`. `text/event-stream`, клиент регистрируется в `FileWatcherService` (`src/server/file-watcher.ts:238-249`). События (`src/types/watch.ts:9-45`), формат строки `data: <JSON>\n\n` (`file-watcher.ts:284-291`):
- `{type:'connected', diffMode, changeType, timestamp, message}` - сразу при подключении;
- `{type:'reload', diffMode, changeType:'file'|'commit'|'staging', timestamp, message}` - при изменениях (debounce 300 мс, `server.ts:1066`);
- `{type:'error', ...}`;
- `{type:'commentsChanged', version, timestamp}`.

Watcher использует `@parcel/watcher` (лениво импортируется, `file-watcher.ts:93`), пути по режимам - `MODE_WATCH_CONFIGS` (`file-watcher.ts:20-48`); при `DiffMode.SPECIFIC` слежение отключено. Перед broadcast инвалидируется кеш дифов (`server.ts:189-193`).

**`GET /api/heartbeat`** - `server.ts:985-1020`. `text/event-stream`; сразу `data: connected`, далее `data: heartbeat` каждые 5 секунд. **Важно для обертки:** на `req.on('close')` (закрытие вкладки/навигация) - если `--keep-alive` не задан, сервер через 100 мс останавливает watcher, печатает все комментарии в stdout и делает `process.exit(0)` (`server.ts:1008-1018`). С `--keep-alive` - только лог `Client disconnected, but server is staying alive (--keep-alive)`.

### 2.4 Прочее

**`POST /api/open-in-editor`** - `server.ts:858-958`. Body `{filePath: string, line?: number|string, editor?: {id?, command?, argsTemplate?}}`. Editor id берется из body -> `DIFIT_EDITOR` -> `EDITOR` (884). `id === 'none'` -> 400 «Open in editor is disabled». Спавнит detached-процесс. Ответ `{success:true}`; 400 при плохом пути/конфиге, 500 если команда не найдена в PATH. Недоступно для stdin (400).

**`GET /api/user-settings`** / **`PUT /api/user-settings`** - `server.ts:830-856`. Хранение: `~/.difit/config.json` или `$DIFIT_CONFIG_DIR/config.json` (`src/server/user-config.ts:15-21`). Формат `{version:1, client:{...}}`; PUT принимает `{client:{...}}` (shallow merge), лимит 64 KiB (`user-config.ts:13,31-39`), атомарная запись через tmp+rename. 400 `{error:'Invalid user settings payload'}`, 500 при ошибке записи.

**Статика**: в production (`NODE_ENV !== 'development'`, `server.ts:1023-1029`) - `express.static(join(__dirname,'..','client'))`, т.е. `dist/client`. В dev-режиме отдается заглушка HTML на `/` (1031-1047). Catch-all/SPA-fallback роута нет.

---

## 3. Связь CLI <-> сервер (что важно для обертки)

### 3.1 Проброс опций в `startServer`

Два вызова: stdin/PR-ветка `src/cli/index.ts:230-238` и git-ветка `src/cli/index.ts:290-301`.

| `ServerOptions` (`server.ts:49-62`) | Источник CLI |
|---|---|
| `selection` | `resolveDiffSelection()` (только git-ветка) |
| `stdinDiff` | stdin или патч `--pr` |
| `preferredPort` | `--port` |
| `host` | `--host` |
| `openBrowser` | `options.open` (`--no-open` -> false; принудительно false в background) |
| `clearComments` | `--clean` |
| `keepAlive` | `--keep-alive` (принудительно true в background) |
| `contextLines` | `--context` (только git-ветка) |
| `diffMode` | `determineDiffMode()` (только git-ветка) |
| `repoPath` | `getGitRoot()` = `git rev-parse --show-toplevel`; при неудаче `undefined` -> `process.cwd()` (`index.ts:257-264`, `server.ts:128`) |
| `commentImports` | `--comment` + PR-треды (передается только если непустой) |
| `ignoreWhitespace` | **из CLI не пробрасывается** (только API/клиент) |

### 3.2 Выбор порта

`startServerWithFallback()` - `server.ts:1087-1122`. Default `options.preferredPort || 4966` (строка 1052), host `options.host || 'localhost'` (1053). При `EADDRINUSE` - рекурсивно `port + 1`, с логом в stdout: `Port <N> is busy, trying <N+1>...` (1108). Иные ошибки -> `Failed to launch a server: <msg>`. URL: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}` (1097-1098).

### 3.3 stdout (контракт для обертки)

**Обычный запуск** (`src/cli/index.ts:248-331`, порядок строк):
```
Port 4966 is busy, trying 4967...        # опционально, из server.ts:1108
(пустая строка)
🚀 difit server started on http://localhost:4966
📋 Reviewing: <targetCommitish>          # или "diff from stdin" / <pr-url>
🔒 Keep-alive mode: server will stay running after browser disconnects   # если --keep-alive
🧹 Starting with a clean slate - all existing comments will be cleared   # если --clean
# далее один из трех:
! No differences found. Browser will not open automatically.   (желтый \x1b[33m) + "   Server is running at <url> ..."
🌐 Opening browser...
💡 Use --open to automatically open browser
Press Ctrl+C to stop the server          # только в stdin/PR-ветке (index.ts:253)
```
Готовый regex из репозитория для парсинга URL: `/^🚀 difit server started on (https?:\/\/\S+)$/` (`dev/dev-stdout.js:1`) и `/^Port \d+ is busy, trying \d+\.\.\.$/` (`dev/dev-stdout.js:2`); VS Code-расширение использует `/difit server started on (https?:\/\/\S+)/i` (`packages/vscode/src/extension.ts:12`).

**`--background`** (`src/cli/background.ts`): родитель форкает detached-child (`node <scriptPath> <args без --background> --keep-alive --no-open`, env `DIFIT_BACKGROUND_CHILD=1`, stdio `['ignore','ignore','pipe','ipc']`, `background.ts:52-67`), ждет IPC-handshake до 10 с (`background.ts:128-134`) и печатает в stdout **ровно одну строку JSON**:
```json
{"port":4966,"url":"http://localhost:4966","pid":12345}
```
(`background.ts:103`, `emitBackgroundHandshake` 28-31, вызовы из `index.ts:241` и `index.ts:304`). При ранней смерти child'а - reject с текстом его stderr; при таймауте - `Timed out while starting background difit server`. В background-режиме обычные `🚀/📋` строки **не печатаются** (ранний `return` в `index.ts:240-246` и `303-309`), интерактивный prompt про untracked отключен.

**Завершение / выдача комментариев** - два независимых пути:
1. `SIGINT` (Ctrl+C) в CLI (`index.ts:333-350`): CLI сам делает `fetch('http://localhost:<port>/api/comments-output')` и печатает текст, затем `process.exit(0)`. **Только в git-ветке** - для stdin/PR-ветки обработчик SIGINT не регистрируется (там `return` на 254).
2. Отключение браузера без `--keep-alive`: сервер сам печатает `formatCommentsOutput(...)` и завершает процесс (`server.ts:961-966`, `1009-1017`).

Формат вывода комментариев (`src/utils/commentFormatting.ts:167-178`):
```
📝 Comments from review session:
==================================================
diff <base>..<target>          # только для commit-range, не для working/staged/./stdin (строки 28-51)
src/foo.ts:L42                 # или L36-L48, суффикс " (old)" для side=old
тело комментария
Reply 1 (author)
тело ответа
=====
...
==================================================
Total comments: N
```

### 3.4 Прочие точки интеграции

- Ошибки CLI всегда идут в **stderr** с префиксом `Error: ...` и `exit(1)` (общий catch - `index.ts:351-354`).
- Переменные окружения: `DIFIT_BACKGROUND_CHILD` (`background.ts:9`), `DIFIT_EDITOR` / `EDITOR` (`server.ts:884`), `DIFIT_CONFIG_DIR` (`user-config.ts:17`), `NODE_ENV` (статика vs dev-заглушка, `server.ts:1023`), `GH_TOKEN`/`GITHUB_TOKEN`/`GH_HOST` для `gh` (README:88-98).
- `repositoryId` = SHA-256 абсолютного пути репозитория (`server.ts:129`) - используется клиентом как ключ изоляции localStorage; полезно для маппинга сессий в обертке.
- Программный запуск в обход CLI возможен: `import { startServer } from 'difit/dist/server/server.js'` - так делает VS Code-расширение (`packages/vscode/src/server-entry.ts:1,25-31`, передает `selection`, `diffMode`, `repoPath`, `openBrowser:false`, `keepAlive:true` и отдает `{type:'ready', url, port, isEmpty}` через IPC).
