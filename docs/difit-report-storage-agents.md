# difit - детальный разбор: хранение данных и интеграция с AI-агентами

Отчет субагента (зона: хранение данных, интеграция с агентами, возможности для обертки, GitHub/GitLab). Репозиторий `/home/claude/difit`, версия 5.0.11. Часть серии разборов, сводный файл: `difit-architecture-report.md`.

Ключевой факт для обертки: **никакой персистентности комментариев на диске нет** - только localStorage браузера + in-memory на сервере.

---

## 1. Хранение данных

### 1.1 Два независимых слоя хранения

| Слой | Где | Файл | Живет |
|---|---|---|---|
| Браузер (основной) | `localStorage` | `src/client/services/StorageService.ts` | до очистки браузера |
| Сервер (сессия) | `Map` в памяти процесса | `src/server/server.ts:249` | до завершения процесса |
| UI-настройки (не комментарии) | файл на диске `~/.difit/config.json` | `src/server/user-config.ts` | постоянно |

Серверный слой - просто `const commentSessions = new Map<string, CommentSessionState>();` (`server.ts:249`), где

```ts
interface CommentSessionState {
  threads: DiffCommentThread[];
  version: number;
}
```
(`server.ts:101-104`). **Ничего не пишется на диск.** Единственная запись на диск во всем сервере - `~/.difit/config.json` через `updateUserClientSettings()` (`user-config.ts`), и там хранятся только UI-preferences (тема, split/unified, сайдбар), путь переопределяется env-переменной `DIFIT_CONFIG_DIR`.

### 1.2 Формат комментария (актуальный, v2 - треды)

`src/types/diff.ts:104-124`:

```ts
export interface DiffCommentThread {
  id: string;
  filePath: string;
  createdAt: string;   // ISO 8601
  updatedAt: string;
  position: DiffCommentPosition;      // { side: 'old'|'new', line: number | {start,end} }
  codeSnapshot?: { content: string; language?: string };
  messages: DiffCommentMessage[];     // [0] = корень треда, дальше - реплаи
}
export interface DiffCommentMessage {
  id: string; body: string; author?: string; createdAt: string; updatedAt: string;
}
```

Корневая структура в localStorage (`types/diff.ts:177-188`):

```ts
export interface DiffContextStorage {
  version: 2;
  baseCommitish: string;
  targetCommitish: string;
  baseMode?: 'direct' | 'merge-base';
  createdAt: string;
  lastModifiedAt: string;
  threads: DiffCommentThread[];
  viewedFiles: ViewedFileRecord[];          // { filePath, viewedAt, diffContentHash }
  appliedCommentImportIds: string[];        // sha256 уже примененных --comment пачек
}
```

Есть три поколения формата, все живут одновременно:
- `Comment` (`types/diff.ts:75-84`, плоский, поля `file/line/body/timestamp`) - легаси-хук `useLocalComments.ts` с ключом `difit-comments-${commitHash}` (мертвый/legacy-путь, App.tsx использует `useDiffComments`);
- `LegacyDiffComment` + `LegacyDiffContextStorage` (`version: 1`, поле `comments`) - читается и на лету мигрируется в v2 через `migrateLegacyComment()` (`StorageService.ts:23-41`, `188-205`);
- `DiffCommentThread` + `DiffContextStorage` (`version: 2`, поле `threads`) - актуальный.

### 1.3 Привязка к коммиту/ветке/репозиторию (ключ localStorage)

Схема ключа (`StorageService.ts:13-16, 63-87`):

```
difit-storage-v1/{repositoryId}/{encode(base)}-{encode(target)}[-merge-base]
difit-viewed-index-v1/{repositoryId}          // отдельный индекс viewed-хешей, cap 5000 записей
```

- `repositoryId` = `sha256(абсолютный путь к git-root)`, вычисляется на сервере: `const repositoryId = createHash('sha256').update(repositoryPath).digest('hex');` (`server.ts:129`) и отдается клиенту в `/api/diff` (`server.ts:366`). Это дает изоляцию между репозиториями (тест: `src/client/hooks/repositoryIsolation.integration.test.ts`).
- Нормализация ревизий (`StorageService.ts:92-135`): `.`/`working` -> `WORKING`, `staged` -> `STAGED`, `HEAD`/`@` -> реальный хеш, имена веток -> хеш через `branchToHash`. Для `@^`, `HEAD~1` и т.п. нормализация невозможна - код сам пишет warning про коллизию ключей:
  > `[StorageService] Cannot normalize symbolic ref '${commitish}' - may cause key collision.`
- Спец-символы в имени ветки кодируются: `feature/add-auth` -> `feature_2f_add_2d_auth`.
- **Важно для обертки: привязка идет к паре ревизий, а не к «ветке/задаче».** Понятия «сессия ревью по задаче» в difit нет. Ветка попадает в ключ только если ее не удалось резолвить в хеш; если резолвится - ключ по хешу коммита, т.е. после нового коммита в ветке комментарии «уезжают» в другой ключ.

Серверный ключ сессии другой и проще (`utils/diffSelection.ts:36-38`):
```ts
export function getDiffSelectionKey(selection) {
  return `${selection.baseCommitish}:${selection.targetCommitish}:${normalizeBaseMode(selection.baseMode)}`;
}
```

### 1.4 Что происходит при перезапуске / закрытии

- **Перезапуск сервера:** серверная `Map` теряется полностью. Комментарии выживают только в localStorage браузера, и при следующем открытии того же диапазона диффа клиент их поднимает и **пушит обратно на сервер** - bootstrap-логика в `App.tsx:904-972`: `fetchServerThreads()` -> `mergeCommentThreads(serverThreads, threads)` -> `syncThreadsToServer(nextThreads)`.
- **Закрытие вкладки:** `beforeunload` -> `navigator.sendBeacon('/api/comments', {threads, baseVersion})` (`App.tsx:1006-1011`), затем SSE `/api/heartbeat` рвется, и сервер (без `--keep-alive`) через 100 мс печатает комментарии в stdout и делает `process.exit(0)` (`server.ts:1002-1019`).
- **Конкурентная запись** (агент пишет пока открыт браузер): optimistic-concurrency по `version`. Клиент шлет `baseVersion`, сервер при расхождении мержит вместо перезаписи (`server.ts:744-750`):
  > `// Stale baseVersion means another writer (e.g. an agent) changed comments since the client's last read, so merge rather than overwrite.`
  Любое изменение сессии рассылает SSE-событие `commentsChanged` всем клиентам (`server.ts:726-730`), клиент реагирует в `useFileWatch.ts:84-88` -> `handleCommentsChanged` (`App.tsx:573-576`).

### 1.5 Viewed-состояние файлов

`ViewedFileRecord { filePath, viewedAt, diffContentHash }` - SHA-256 контента диффа файла; при изменении диффа viewed сбрасывается. Плюс отдельный кросс-диапазонный индекс `difit-viewed-index-v1/{repositoryId}` с cap `MAX_VIEWED_INDEX_ENTRIES = 5000` для бэджа «changed since you viewed» (`StorageService.ts:466-574`, `hooks/useViewedFiles.ts`).

### 1.6 Утилиты уборки

`StorageService.cleanupOldData(daysToKeep)` и `getStorageSize()` (`StorageService.ts:579-634`) существуют, но **не вызываются автоматически** и не проброшены в UI/CLI. При `QuotaExceededError` - только `console.error('localStorage quota exceeded')` с комментарием `// Could implement cleanup here` (`StorageService.ts:278-281`).

### 1.7 Спека по хранилищу (для понимания замысла)

`.claude/specs/comment-storage-management/{requirements,design,tasks}.md` - исходный дизайн-док. Описывает ровно текущую схему (`difit-storage-v1/{base}-{target}`, хеш диффа для viewed, `cleanupOldData`). Полезно: раздел «Handling Dynamic References» и «Coexistence with Old Data» (`Keep existing difit-comments-${commitHash} keys (read-only)`).

---

## 2. Интеграция с AI-агентами

### 2.1 Skill-файлы (главная точка интеграции)

| Путь | Назначение |
|---|---|
| `skills/difit/SKILL.md` | публичный: «попроси у пользователя ревью через difit» |
| `skills/difit-review/SKILL.md` | публичный: «отревьюй дифф и покажи находки комментариями в difit» |
| `.claude/skills/difit-dev/SKILL.md` | внутренний (`metadata: internal: true`), через `pnpm run dev` |
| `.claude/skills/difit-review/SKILL.md` | внутренний, через `pnpm run dev` |
| `.codex/skills/{difit-dev,difit-review,release,vscode-release}/SKILL.md` | зеркала для Codex |

Устанавливаются командой из README: `npx skills add yoshiko-pg/difit`.

Ключевые цитаты из `skills/difit/SKILL.md`:

> Before running commands, choose `<difit-command>`: If `command -v difit` succeeds, use `difit`. Otherwise, use `npx difit`.

> If the user leaves review comments, they are printed to stdout when the chosen difit command exits.
> When review comments are returned, continue work and address them.
> **If the server is shut down without comments, treat it as "no review comments were provided." Restarting it is unnecessary.**
> Manual verification of whether the page launched correctly is also unnecessary.

Из `.claude/skills/difit-dev/SKILL.md` дополнительно:
> Treat `Client disconnected, shutting down server...` without comments as a successful no-comments outcome.
> Do not insert `--` after `pnpm run dev` in this repository. `pnpm run dev -- ...` breaks argument parsing here.

Формат стартовых комментариев (одинаков во всех скиллах):

```bash
<difit-command> <target> [compare-with] \
  --comment '{"type":"thread","filePath":"src/foobar.ts","position":{"side":"old","line":102},"body":"line 1\nline 2"}' \
  --comment '{"type":"thread","filePath":"src/example.ts","position":{"side":"new","line":{"start":36,"end":39}},"body":"Range comment for L36-L39"}'
```
с правилами: `type: "thread"`; язык тела комментария - язык пользователя; `side: "new"` для целевой стороны, `"old"` для удаленной; range для многострочных; и явный security-guardrail:
> Never copy secrets, tokens, passwords, API keys, private keys, or other credential-like material from the diff into `--comment` bodies or any command-line arguments.

Отдельно в `difit-review`:
> For PR reviews, inspect the PR locally and keep the review result limited to difit output. **Do not post comments back to remote GitHub.**

### 2.2 MCP-сервера НЕТ

Поиск по `mcp|MCP` во всех `.ts/.md/.json` дал единственное совпадение - в JSON-снапшоте демо-сайта (`public/site-data/snapshots/...`). Каталога `.mcp.json`, mcp-серверов, ничего подобного нет. Интеграция построена целиком на CLI + HTTP API.

### 2.3 CLI-подкоманды `difit comment` - недокументированный, но полноценный agent API

`src/cli/comment.ts` (182 строки), регистрируется в `src/cli/index.ts:102` через `.addCommand(createCommentCommand())`. **В README не упоминается вообще** (grep `difit comment` по README/skills - пусто). Только в CHANGELOG (#428).

```
difit comment add [json] --port <port>        # POST /api/comment-imports; json из аргумента или stdin
difit comment get --port <port> [--format text|json]
                                              # text -> GET /api/comments-output
                                              # json -> GET /api/comments-json
difit comment resolve <threadIds...> --port <port>   # alias: remove; DELETE /api/comments/:threadId
```

Все три ходят на `http://localhost:${port}` и печатают JSON в stdout:
- `add` -> `{"success":true,"importId":"<sha256>","count":N,"warnings":[]}`
- `resolve` -> `{"success":bool,"resolved":[...],"notFound":[...],"errors":[...]}`, при `notFound`/`errors` - `process.exit(1)`
- ошибка соединения -> `Error: Cannot connect to difit server on port ${port}. Is the server running?` + exit 1

Это и есть готовый «двусторонний канал» для обертки: агент может добавлять комментарии в уже запущенный инстанс, вычитывать ответы пользователя и резолвить треды без перезапуска.

### 2.4 HTTP API целиком (`src/server/server.ts`)

| Метод + путь | Строка | Назначение |
|---|---|---|
| `GET /api/diff` | 293 | дифф + метаданные; query: `base`, `target`, `baseMode`, `ignoreWhitespace` |
| `GET /api/generated-status/*` | 372 | признак сгенерированного файла |
| `GET /api/revisions` | 414 | ветки, коммиты, `originDefaultBranch`, `resolvedBase/Target` |
| `GET /api/line-count/*` | 447 | |
| `GET /api/blob/*` | 495 | содержимое файла на ревизии |
| `POST /api/comments` | 734 | полная замена/мерж набора тредов, `{threads, baseVersion}` |
| `POST /api/comment-imports` | 764 | **инкрементальный импорт** `CommentImport[]` (thread/reply) с дедупликацией |
| `DELETE /api/comments/:threadId` | 788 | резолв треда |
| `GET /api/comments-json` | 808 | `{version, threads}` |
| `GET /api/comments-output` | 817 | `text/plain`, тот же формат, что печатается в stdout |
| `GET/PUT /api/user-settings` | 830/835 | `~/.difit/config.json` |
| `POST /api/open-in-editor` | 858 | открыть файл:строку в редакторе |
| `GET /api/watch` | 969 | SSE: `connected`/`reload`/`error`/**`commentsChanged`** |
| `GET /api/heartbeat` | 985 | SSE: детект закрытия вкладки -> shutdown |

Все comment-эндпоинты принимают те же query-параметры `?base=&target=&baseMode=` для выбора сессии (`getCommentSelectionFromQuery`, `server.ts:258-276`); без них - текущая активная сессия.

CORS: `res.header('Access-Control-Allow-Origin', 'http://localhost:*')` (`server.ts:156`) - это невалидное значение Origin с точки зрения спеки, реальный кросс-origin доступ из браузера работать не будет; из curl/агента - без проблем.

### 2.5 Формат «Copy All Comments» / stdout

Генерация: `src/utils/commentFormatting.ts`. Один тред:

```
src/components/Button.tsx:L42        # или L42-L48, плюс " (old)" для side==='old'
Тело комментария
Reply 1 (author)
Тело реплая
```

Все треды соединяются разделителем `\n=====\n`. С версии 5.0.11 сверху добавляется строка контекста диффа (`formatDiffContextHeader`): `diff main..feature` или `diff main...feature` для merge-base (для `working`/`staged`/`.`/`stdin` заголовок не добавляется).

Блоки `suggestion` разворачиваются в `ORIGINAL:` / `SUGGESTED:` code-fences (`formatCommentContent`).

Финальный stdout-вывод (`formatCommentsOutput`, он же `GET /api/comments-output`):

```
\n📝 Comments from review session:
==================================================
<все промпты через =====>
==================================================
Total comments: N\n
```

Печатается в двух местах: `outputFinalComments()` при дисконнекте браузера (`server.ts:960-966, 1015`) и по `SIGINT` в CLI (`index.ts:333-350`, там CLI сам делает `fetch('/api/comments-output')` перед выходом).

UI-кнопки: `CommentsDropdown.tsx` - `Copy All Prompt (N)` / `Copy All (N)` в compact-режиме, с пунктами Delete All и View All; per-thread `Copy Prompt` в `CommentThreadCard.tsx:315`. Хоткеи (из CHANGELOG): `Shift+C` - copy all prompt, `Shift+L` - список комментариев, `Shift+D` - удалить все.

### 2.6 Валидация импортируемых комментариев

`src/utils/commentImports.ts`. Строгая нормализация с говорящими ошибками (`Invalid comment import field: position.line` и т.п.), требования: `type in {thread, reply}`, непустой `filePath`, `side in {old,new}`, целые положительные `line`/`start<=end`, непустой trimmed `body`, ISO-таймстемпы. Дедупликация: `rootThreadMatchesImport` (по `id` либо по `filePath+position+body+author+createdAt`) - повторный запуск с тем же `--comment` не задваивает. `reply` цепляется к **самому свежему** треду на той же позиции; если треда нет - warning: `Skipped reply import for {file}:{side}:{line} because no matching thread was found.`

---

## 3. Возможности для обертки

### 3.1 Флаги CLI (`src/cli/index.ts:112-130`)

```
--port <port>            4966, авто +1 при занятости (server.ts:1107)
--host <host>            дефолт localhost, warning при внешнем биндинге
--no-open                не открывать браузер
--comment <json>         repeatable, объект или массив
--pr <url>               GitHub PR
--clean                  очистить комментарии и viewed при старте
--include-untracked      без интерактивного промпта
--keep-alive             не умирать при дисконнекте браузера
--background             демонизация + JSON с {port,url,pid} в stdout
--context <lines>        число строк контекста
--merge-base             база через git merge-base
-v, --version
```

### 3.2 Режим ожидания агента - как он устроен

Штатный «блокирующий» режим: агент запускает `difit .` (foreground), процесс живет пока открыта вкладка; при закрытии вкладки сервер печатает комментарии в stdout и делает `exit(0)`. Скилл прямо инструктирует агента интерпретировать `Client disconnected, shutting down server...` без комментариев как «замечаний нет».

Неблокирующий режим - `--background` (`src/cli/background.ts`): родитель форкает `detached` ребенка с `stdio: ['ignore','ignore','pipe','ipc']`, автоматически добавляя `--keep-alive` и `--no-open`, ждет IPC-handshake (таймаут 10 с) и печатает **ровно одну строку JSON**:

```json
{"port":4966,"url":"http://localhost:4966","pid":12345}
```

затем `child.unref()` и выходит. Дальше обертка общается с демоном через `difit comment get/add/resolve --port`. Это самая удобная точка для «ожидания агента»: poll `GET /api/comments-json` по `version`, либо подписка на SSE `GET /api/watch` (событие `commentsChanged` летит при любой правке комментариев, включая правки из UI).

### 3.3 Exit-коды

- `0` - нормальное завершение (дисконнект браузера, SIGINT).
- `1` - все ошибки валидации/git/сети (`process.exit(1)` в `index.ts` и `comment.ts`), а также `comment resolve` при notFound/error тредов.
- Специальных кодов «есть замечания / нет замечаний» **нет** - различать надо по содержимому stdout (или по `GET /api/comments-json`).

### 3.4 Колбеки/хуки

Формальной hook-системы (плагины, `onReviewFinish`, webhooks) **нет**. Доступные точки расширения:

1. `--comment` при старте + `POST /api/comment-imports` в рантайме;
2. SSE `/api/watch` (`commentsChanged`, `reload`, `connected`, `error`) - единственный push-канал наружу;
3. SSE `/api/heartbeat` - если обертка сама подключится к нему, она станет «клиентом», и сервер не будет глушиться при закрытии реального браузера (обратная сторона: не отпустит сервер, пока обертка держит соединение);
4. stdout-парсинг блока `📝 Comments from review session:`;
5. `POST /api/open-in-editor` и `GET /api/blob/*` - для интеграции с редактором;
6. `~/.difit/config.json` (+ `DIFIT_CONFIG_DIR`) - подмена UI-настроек;
7. Программный запуск: `startServer(options)` экспортируется из `src/server/server.ts` и уже так используется VS Code-расширением (`packages/vscode/src/extension.ts`, `server-entry.ts`, `open-stub.ts`, `watcher-shim.ts` - там сервер форкается как модуль с IPC-сигналом готовности и `open` заглушается). Это готовый шаблон эмбеддинга difit в свою обертку без CLI.

### 3.5 Что происходит при `--clean`

Флаг **не** чистит ничего на сервере напрямую: он прокидывается в ответ `/api/diff` полем `clearComments` (`server.ts:365`), и уже клиент в `App.tsx:892-902` вызывает `clearAllComments({resetAppliedCommentImportIds: true})` + `clearViewedFiles()`, после чего ставит `pendingBootstrapAfterLocalResetRef`, чтобы дальше принять серверное состояние как есть. Следствие для обертки: **`--clean` без открытого браузера не делает ничего.** Также важно: импортированные через `--comment` комментарии переживают clean (CHANGELOG: «Preserve imported comments after clean (#358)») - потому что они лежат в серверной сессии и подтягиваются после сброса.

### 3.6 Ограничения, важные для проектирования обертки

- Комментарии не привязаны к «ветке/задаче» - только к паре ревизий; смена HEAD в ветке меняет ключ хранилища.
- Нет истории/архива ревью, нет экспорта в файл, нет импорта из файла (только JSON в argv/stdin).
- localStorage привязан к origin `http://localhost:PORT` -> **при другом порте комментарии не видны** (именно из-за этого UI-настройки в 5.0.9 вынесли в `~/.difit/config.json`: «Persist UI settings ... so they survive across ports (#431)»). Для обертки это значит: либо фиксировать порт, либо самому персистить треды через `comment get --format json` / `comment add`.
- Нет аутентификации на API; биндинг по умолчанию localhost.

---

## 4. GitHub PR (`--pr`) и GitLab

### 4.1 Как работает `--pr`

`src/cli/github.ts` + ветка в `src/cli/index.ts:168-201`.

1. Патч берется **через CLI `gh`, не через API**: `execFileSync('gh', ['pr', 'diff', prArg])` (`github.ts:331`). Далее патч скармливается серверу как `stdinDiff` - то есть режим PR технически идентичен stdin-режиму (`options.stdinDiff`), git-операции отключены (`openInEditorAvailable: false`, `/api/generated-status` и `/api/blob` возвращают 400).
2. Непорешенные inline-треды PR подтягиваются GraphQL-запросом `gh api graphql --hostname <host>` (`github.ts:72-109, 376-436`) с пагинацией по 100, и конвертируются в `CommentImport[]`: корневой комментарий -> `type: 'thread'`, остальные -> `type: 'reply'` c сохранением `id`, `author.login`, `createdAt/updatedAt`. Фильтр: `if (thread.isResolved || thread.isOutdated || thread.subjectType !== 'LINE') return [];` (`github.ts:234`).
3. Маппинг позиций: `diffSide === 'RIGHT'` -> `side: 'new'` по `line`/`startLine`; `LEFT` -> `side: 'old'` по `originalLine`/`originalStartLine`; при неконсистентных данных - warning `Warning: Skipping PR review thread <id>: ...` и пропуск.
4. Ошибка `gh` оборачивается с подсказкой: `` `${message}\nTry: gh auth login` ``.
5. Несовместимости: `--pr` нельзя с позиционными аргументами, с `--merge-base`, с `--context`.
6. Аутентификация - GitHub CLI: `gh auth login`, либо `GH_TOKEN`/`GITHUB_TOKEN`; GitHub Enterprise - `gh auth login --hostname ...` или `GH_HOST`. Хост берется прямо из URL PR (`parseGitHubPrUrl` -> `urlObj.hostname` -> `--hostname`), так что GHE работает из коробки.
7. Комментарии обратно в GitHub **не публикуются** - ни в коде, ни в скиллах (скилл явно запрещает).

Устаревшее место в документации: `docs/structure.md` утверждает, что PR-режим использует `@octokit/rest` и `GITHUB_TOKEN`/`gh auth token` - это неправда для текущего кода (octokit нет в зависимостях `package.json`; используется `execFileSync('gh', ...)`). Файл `docs/structure.md` в целом заметно устарел (список эндпоинтов, список флагов).

### 4.2 GitLab

**Полностью отсутствует.** Grep по `gitlab` (case-insensitive) во всех `*.ts`, `*.tsx`, `*.md`, `*.json` вне `node_modules` - 0 совпадений. Ни MR-режима, ни абстракции провайдера: `--pr` жестко завязан на бинарь `gh`, `parseGitHubPrUrl` требует путь вида `/owner/repo/pull/N`, GraphQL-запрос - гитхабовский.

Точки, куда естественно встраивать GitLab в обертке:
- получить патч самим (`glab mr diff` или REST `/merge_requests/:iid/raw_diffs`) и подать через **stdin**: `... | difit` - это полностью поддерживаемый путь (`shouldReadStdin` в `src/cli/utils.ts`, явный режим через `difit -`);
- дискуссии MR сконвертировать в `CommentImport[]` и передать через `--comment` (repeatable) или `difit comment add --port` в рантайме - формат один и тот же, `id` можно проставить своим (например, id заметки GitLab), что даст дедупликацию при повторных синках;
- обратную синхронизацию (difit -> GitLab) делать через `difit comment get --port N --format json` + `DELETE /api/comments/:threadId` (`comment resolve`) после успешной публикации.

Учтите ограничение stdin-режима: `baseCommitish/targetCommitish` становятся `'stdin'`, ключ localStorage - `stdin-stdin`, то есть **все MR будут делить одно хранилище комментариев в браузере**, и `formatDiffContextHeader` не добавит заголовок диффа (`isNonRangeCommitish` включает `'stdin'`). Для разделения состояния по MR обертке придется либо давать каждому MR свой порт, либо держать состояние у себя и заливать его через `comment add` при старте.
