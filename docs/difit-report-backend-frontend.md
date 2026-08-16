# difit - детальный разбор: бэкенд и фронтенд

Отчет субагента (зона: архитектура бэкенда и фронтенда). Репозиторий `/home/claude/difit`, версия 5.0.11. Часть серии разборов, сводный файл: `difit-architecture-report.md`.

---

## 1. Общая структура

### Монорепо
Да, pnpm-воркспейс, но «легкий»: корень + один пакет.

- `pnpm-workspace.yaml` - `packages: ['.', 'packages/*']`; `onlyBuiltDependencies: @parcel/watcher, @vscode/vsce-sign, esbuild, keytar, lefthook`
- Единственный подпакет - `packages/vscode` (VS Code-расширение `difit-vscode` v0.1.0)
- Пакетный менеджер зафиксирован: `pnpm@11.6.0`, Node `>=21`, `mise.toml` для пиннинга тулчейна

### Структура `src/`
```
src/
├── cli/        index.ts, utils.ts, comment.ts, github.ts, background.ts
├── server/     server.ts, git-diff.ts, file-watcher.ts, user-config.ts, generated-file-check.ts
├── client/     App.tsx, main.tsx, index.html
│   ├── components/ (32 .tsx)
│   ├── viewers/    (Text/Markdown/Notebook/Image + registry.ts, types.ts, PreviewModeTabs.tsx)
│   ├── hooks/      (13 хуков + keyboardNavigation/)
│   ├── utils/      (23 модуля + navigation/)
│   ├── contexts/   (FileLevelTokensContext, WordHighlightContext)
│   ├── services/   (StorageService.ts, userSettings.ts)
│   ├── constants/, styles/global.css, themeBootstrap.ts
├── site/       статический демо-сайт для GitHub Pages (StaticDiffApp, SitePage, staticApiBridge)
├── types/      diff.ts, watch.ts, *.d.ts
└── utils/      общие для cli/server/client: commentFormatting, commentImports, diffSelection,
                diffMode, editorOptions, fileUtils, suggestionUtils, createId
```
Тесты **колокированы** (`*.test.ts[x]` рядом с кодом), всего ~35k строк по `src/`.

### Технологии и версии (`package.json`)

Runtime-зависимости:
| Пакет | Версия | Роль |
|---|---|---|
| `express` | ^5.1.0 | HTTP-сервер (не hono/fastify) |
| `simple-git` | ^3.28.0 | git-обертка |
| `commander` | ^15.0.0 | CLI |
| `@parcel/watcher` | ^2.5.1 | нативный файловый вотчер |
| `react` / `react-dom` | ^19.1.0 | UI (README устарел: пишет «React 18») |
| `prism-react-renderer` ^2.4.1, `prismjs` ^1.30.0, `prism-svelte` ^0.5.0 | | подсветка синтаксиса |
| `diff` | ^9.0.0 | word-level diff на клиенте |
| `react-markdown` ^10, `remark-gfm` ^4, `remark-breaks` ^4 | | рендер markdown/комментариев |
| `mermaid` | ^11.13.0 | диаграммы в md |
| `lucide-react` ^1.0.0, `@floating-ui/react` ^0.27 | | иконки, поповеры |
| `react-hotkeys-hook` | ^5.2.4 | горячие клавиши |
| `js-yaml` ^4.3, `open` ^11 | | frontmatter, открытие браузера |

Dev: `vite` ^8, `@vitejs/plugin-react` ^6, `tailwindcss` ^4.1.11 + `@tailwindcss/postcss`, `typescript` ^6, `vitest` ^4 + `happy-dom` ^20 + Testing Library, `oxlint`/`oxfmt` (вместо eslint/prettier), `lefthook`, `knip`, `playwright` (только для perf-скриптов).

**Нет** `@octokit/rest` (в `docs/structure.md` он упомянут - документ устарел), интеграция с GitHub идет через CLI `gh`.

Сборка: два таргета - `tsc --project tsconfig.cli.json` (cli+server+types+utils -> `dist/cli`, `dist/server`) и `vite build` (`root: src/client` -> `dist/client`). Бинарь `dist/cli/index.js`.

---

## 2. Бэкенд

### Точка входа CLI - `src/cli/index.ts` (386 строк)
Commander-программа `difit [commit-ish] [compare-with]`. Опции: `--port` (4966), `--host`, `--no-open`, `--comment <json>` (повторяемая), `--pr <url>`, `--clean`, `--include-untracked`, `--keep-alive`, `--background`, `--context <lines>`, `--merge-base`.

Ключевые функции:
- `resolveDiffSelection()` (строки 37-55): если `compare-with` не задан - `working -> staged`, спец-аргументы (`.`, `staged`) -> `HEAD`, иначе `commitish + '^'`.
- `determineDiffMode()` (57-79) - маппинг в `DiffMode` для вотчера.
- Подкоманда `difit comment add|get|resolve` - `src/cli/comment.ts` (HTTP-клиент к живому серверу, для агентов).
- Фоновый режим - `src/cli/background.ts`: `spawn(detached, stdio ['ignore','ignore','pipe','ipc'])`, ребенок шлет IPC-handshake `{port,url,pid}`, родитель печатает JSON и отцепляется. Env-маркер `DIFIT_BACKGROUND_CHILD`.
- stdin-режим: `shouldReadStdin()` в `src/cli/utils.ts:37` - по `fstatSync(0)` определяет pipe/file/socket или явный аргумент `-`.
- `getGitRoot()` - `execSync('git rev-parse --show-toplevel')` (`src/cli/utils.ts:50`).

### Сервер - `src/server/server.ts` (1122 строки)
Единственная экспортируемая функция `startServer(options: ServerOptions)` - создает `express()`, все внутри одного замыкания (нет роутеров/слоев).

Состояние в памяти:
- `diffDataCache: Map<string, DiffResponse>` - LRU на `MAX_DIFF_CACHE_ENTRIES = 8`, ключ `getDiffSelectionKey(selection) + ignoreWhitespace` (`createDiffCacheKey`, строки 64-99)
- `generatedStatusCache` - TTL 60 с
- `commentSessions: Map<string, CommentSessionState>` - комментарии **в памяти**, ключ = ревизионная пара; у каждой сессии `version` для оптимистичной конкуренции
- `repositoryId = sha256(абсолютный путь репо)` - используется клиентом для изоляции localStorage

### API-эндпоинты
| Метод + путь | Файл:строка | Назначение |
|---|---|---|
| `GET /api/diff` | server.ts:293 | основной; query `base`, `target`, `baseMode`, `ignoreWhitespace` |
| `GET /api/generated-status/*` | :372 | сгенерированный ли файл |
| `GET /api/revisions` | :414 | ветки, 20 последних коммитов, спец-опции |
| `GET /api/line-count/*` | :447 | число строк в blob (для expand) |
| `GET /api/blob/*` | :495 | сырой blob (картинки, expand-контекст), content-type по расширению |
| `POST /api/comments` | :734 | сохранить треды (+ `baseVersion` -> merge при конфликте) |
| `POST /api/comment-imports` | :764 | внедрить комментарии от агента |
| `DELETE /api/comments/:threadId` | :788 | resolve треда |
| `GET /api/comments-json` | :808 | `{version, threads}` |
| `GET /api/comments-output` | :817 | text/plain, формат для агента |
| `GET/PUT /api/user-settings` | :830/:835 | `~/.difit/config.json` |
| `POST /api/open-in-editor` | :858 | `spawn(detached)` редактора |
| `GET /api/watch` | :969 | **SSE** - события изменений файлов и `commentsChanged` |
| `GET /api/heartbeat` | :985 | **SSE** - детект закрытия вкладки -> graceful shutdown |

CORS: `Access-Control-Allow-Origin: http://localhost:*` (строки 155-160 - заголовок буквальный, с wildcard-портом, браузером это не матчится; работает за счет same-origin в проде).

Порт: `startServerWithFallback()` (:1087) - рекурсивный retry `port+1` на `EADDRINUSE`.

### Как получается git diff - `src/server/git-diff.ts` (873 строки)
Класс `GitDiffParser`, `simpleGit(repoPath)`. Не `git diff --name-status` + отдельные вызовы: **одна инвокация** `git.diff(diffArgs)` ради latency на больших репо (комментарий на строке 122).

Формирование `diffArgs` (`parseDiff`, строки 59-144):
- `working` -> `[]` (unstaged: worktree vs index)
- `staged` -> `['--cached', base]`
- `.` -> `[base]` (все незакоммиченные)
- обычные ревизии -> `[baseHash, targetHash]` через `git.revparse`
- `--merge-base`: `resolveBaseCommitish()` (:49) вызывает `git merge-base <target> <base>`
- всегда добавляется `--no-ext-diff --color=never`; опционально `-w` и `-U<contextLines>`

Прочие git-операции: `validateCommit` (`git.show([c,'--name-only'])` или `git.status()`), `getBlobContent` (:618 - для `working`/`.` читает с ФС через `realpathSync`, для `staged` - `git show :path`, иначе `git rev-parse ref:path` + `git cat-file blob`, все через `execFileSync` от инъекций, лимит 10 МБ), `getLineCount`, `getRevisionOptions` (:806 - `branchLocal` + `log({maxCount:20})` + определение `origin/HEAD`), `getGeneratedStatus`, `check-attr -z linguist-generated` чанками по 200 файлов (:247).

Безопасность путей: `normalizeRepositoryRelativePath` (git-diff.ts:29) и `parseRepositoryRelativePath` (server.ts:203) - запрет абсолютных путей и `..`.

### Парсер диффа (собственный, не библиотека)
Все в `git-diff.ts`:
- `parseUnifiedDiff` (:146) - split по `/^diff --git /m`; если совпадений нет (обычный `diff -u` из stdin) - фолбэк `splitPlainUnifiedDiff` (:172), который считает строки по хедерам `@@` чтобы найти границы файлов
- `parseFileBlock` (:460) - статус (`added`/`deleted`/`renamed`/`modified`) по `new file mode` / `deleted file mode` / `/dev/null` / `rename from|to`
- `decodeGitPath` (:300) - полноценный декодер git-экранирования (октальные последовательности, `\t\n\r\b\f\v\a\\"`, префиксы `a/ b/ c/ i/ w/`)
- `parseDiffHeaderPaths` (:412) - разбор путей с пробелами/кавычками
- `parseChunks` (:536) - построение `DiffChunk[]`/`DiffLine[]` с ведением oldLineNumber/newLineNumber
- `parseStdinDiff` (:608) - тот же парсер для stdin/`--pr`

Типы: `src/types/diff.ts` (`DiffFile`, `DiffChunk`, `DiffLine`, `DiffResponse`, `DiffSelection`, `DiffCommentThread`, `DiffContextStorage` v2 и legacy v1, `CommentImport`).

### Поддержка commit-ish / веток / working / staged
Валидация - `validateDiffArguments` / `validateCommitish` в `src/cli/utils.ts:62+` (SHA 4-40, `HEAD`, `@`, суффиксы `^`/`~N`, правила именования git-ref). Правила: `staged` допустим как base только когда target = `working`; `working` не комбинируется с произвольным base. Ревизии можно менять **на лету из UI** (`GET /api/diff?base=&target=&baseMode=` + `RevisionSelector`), сервер обновляет `currentSelection`/`currentCommentSelection`.

### Раздача фронтенда
`server.ts:1022-1048`: `isProduction = NODE_ENV !== 'development'` (т.е. прод по умолчанию) -> `express.static(join(__dirname,'..','client'))`, т.е. `dist/client`. В dev-режиме отдается заглушка-HTML, а реальный UI обслуживает Vite на :5173 с прокси `/api` -> `VITE_DIFIT_API_URL` (`vite.config.ts`).

### Авто-перезагрузка - `src/server/file-watcher.ts` (323 строки)
`FileWatcherService`: `@parcel/watcher` (динамический `import('@parcel/watcher')` в `setupWatchers`, чтобы отсутствие нативного бинарника деградировало в «без live-reload») + **SSE** (не websocket).
- `MODE_WATCH_CONFIGS` (:20) - какие пути смотреть в зависимости от `DiffMode` (`default`/`working`/`staged`/`dot`/`specific`); для `specific` вотчинг отключен
- Фильтрация: glob-игноры, `.gitignore` через `git.checkIgnore`, для `.git` - только релевантные файлы (`HEAD`, `index`) по `isRelevantGitFile` (:185)
- `resolveGitDir` (:157) - `git rev-parse --git-dir`, корректно работает с worktree
- Дебаунс 300 мс -> `onCacheInvalidate()` (сбрасывает diff-кеш сервера) -> `broadcast()` события `reload` всем SSE-клиентам
- Тем же каналом идет `commentsChanged` (server.ts:726) - так агент, добавивший комментарий через `difit comment add`, мгновенно виден в UI

Типы событий - `src/types/watch.ts`: `connected | reload | error | commentsChanged`.

### TUI-режим
**Отсутствует.** Ни `ink`, ни `blessed`, ни флага `--tui`. «Блокировка ожидания агента» реализована иначе: процесс `difit` живет, пока открыта вкладка (SSE `/api/heartbeat`), при закрытии печатает комментарии в stdout и выходит (`server.ts:985-1020`, `outputFinalComments` :961). Флаги `--keep-alive` и `--background` управляют этим поведением.

### GitHub PR - `src/cli/github.ts` (436 строк)
Через внешний бинарь `gh` (`execFileSync`), без токенов в коде:
- `getPrPatch()` - `gh pr diff <url>` -> отдается как stdinDiff
- `getPrCommentImports()` - `gh api graphql` с пагинацией `reviewThreads(first:100)`, конвертация нерешенных/неустаревших LINE-тредов в `CommentImport[]` (учет `diffSide` RIGHT/LEFT, multi-line `startLine`/`originalStartLine`)

### Конфиг пользователя - `src/server/user-config.ts`
`~/.difit/config.json` (или `DIFIT_CONFIG_DIR`), лимит 64 КБ, атомарная запись через `tmp + rename`, shallow-merge.

---

## 3. Фронтенд

### Точка входа
`src/client/main.tsx` - React 19 `createRoot` + `<HotkeysProvider initiallyActiveScopes={['navigation']}>` + `<App/>`. HTML - `src/client/index.html`. Стили - `src/client/styles/global.css`: Tailwind v4 (`@import "tailwindcss"` + `@theme` с GitHub-палитрой `--color-github-*`, `--color-diff-addition-bg` и т.д.), PostCSS через `postcss.config.js`.

### `App.tsx` (1608 строк) - «god component»
Держит почти весь верхнеуровневый стейт: `diffData`, `diffDataVersion`, `diffMode` (`split`/`unified`), `ignoreWhitespace`, `sidebarWidth`/`isFileTreeOpen`, `collapsedFiles`, `selectedRevision`, модалки (Settings/Help/CommentsList/RevisionDetail).

Загрузка диффа - `fetchDiffData` (App.tsx:690) с `AbortController` + монотонным `diffRequestIdRef` для отмены гонок.

### Иерархия рендера диффа
```
App
└── DiffViewer                (components/DiffViewer.tsx, 389)  - на файл; header, collapse, lazy prefetch по IntersectionObserver
    └── getViewerForFile()    (viewers/registry.ts)             - выбор вьюера по пути
        ├── TextDiffViewer      (viewers/TextDiffViewer.tsx)    - default
        │   └── DiffChunk       (components/DiffChunk.tsx, 577) - inline/unified режим
        │       └── SideBySideDiffChunk (870)                   - split-режим
        │           └── DiffLineRow / DiffCodeLine
        ├── MarkdownDiffViewer  (862) - + MermaidDiagram, FrontmatterTable, PreviewModeTabs
        ├── NotebookDiffViewer  (1257) - .ipynb
        └── ImageDiffViewer     (318) - через /api/blob
```
Реестр вьюеров расширяемый: `DiffViewerRegistration {id, match, Component, canExpandHiddenLines}` в `viewers/types.ts`.

### Side-by-side vs inline
Один флаг `DiffViewMode = 'split' | 'unified'` (`src/types/diff.ts:27`, нормализация синонимов `side-by-side`/`inline` в `src/utils/diffMode.ts`). `DiffChunk` при `mode==='split'` делегирует в `SideBySideDiffChunk`, иначе рендерит построчно сам. На мобильных принудительно `unified` (App.tsx:769). Режим персистится в localStorage (`difit.diffViewMode`) **и** на сервер через `/api/user-settings` (чтобы переживать смену порта).

### Подсветка синтаксиса
- `components/PrismSyntaxHighlighter.tsx` - база на `prism-react-renderer`
- `components/EnhancedPrismSyntaxHighlighter.tsx` - поверх: подсветка всех вхождений слова под курсором (через `contexts/WordHighlightContext`, задержка 200 мс)
- `utils/languageLoader.ts` - динамический `import('prismjs/components/prism-*.js')` с учетом зависимостей (php->markup-templating, scala->java), кеш промисов
- `utils/languageDetection.ts` - детект языка и `isWholeFileHighlightExtension` (html/vue и т.п. токенизируются целым файлом через `useFileLevelTokens` + `/api/blob`, чтобы `<script>`/`<style>` подсвечивались своим языком)
- `utils/syntaxThemes.ts`, `utils/themeLoader.ts`, `themeBootstrap.ts` - темы
- word-level diff внутри строки: `utils/wordLevelDiff.ts` (пакет `diff`) + `components/WordLevelDiffHighlighter.tsx`

### UI комментариев
`CommentButton` (плюсик на строке) -> `CommentForm` -> `CommentThreadCard` (треды с ответами, редактирование, автор-бейджи, «outdated»-маркер) -> `CommentBodyRenderer` (react-markdown + gfm), `CommentsDropdown`, `CommentsListModal` (список всех, навигация по `findCommentPosition`), `SuggestionTemplateButton` (```suggestion). Прочее: `FileList` (дерево файлов, viewed/folder-toggle), `DiffViewerHeader`, `ExpandButton`, `RevisionSelector` + `RevisionDetailModal`, `SettingsModal`, `HelpModal`, `DiffQuickMenu`, `OpenInEditorButton`, `ReloadButton`, `SparkleAnimation` (когда все файлы просмотрены).

### Стейт-менеджмент
**Никаких Redux/Zustand/Jotai.** Только React-примитивы:
- `useState`/`useRef`/`useMemo` в `App.tsx`
- 2 контекста: `contexts/FileLevelTokensContext.tsx`, `contexts/WordHighlightContext.tsx`
- Кастомные хуки как «сторы»:
  - `hooks/useDiffComments.ts` (471) - треды, привязанные к паре ревизий; `generateThreadPrompt`/`generateAllCommentsPrompt`
  - `hooks/useViewedFiles.ts` (359) - просмотренные файлы + детект «изменилось после просмотра» по SHA-256 хешу диффа, авто-viewed паттерны (`utils/autoViewedPatterns.ts`)
  - `hooks/useExpandedLines.ts` (645) - подгрузка скрытого контекста через `/api/line-count` и `/api/blob`
  - `hooks/useLazyDiffRendering.ts` (332) - прогрессивный рендер файлов
  - `hooks/useKeyboardNavigation.ts` (600) + `hooks/keyboardNavigation/*` - j/k/v/... навигация
  - `hooks/useAppearanceSettings.ts`, `useViewport.ts`, `useFileLevelTokens.ts`, `useHighlightedCode.ts`, `useClickOutside.ts`
  - `hooks/useLocalComments.ts` - **legacy**, простой localStorage-стор (не используется `App.tsx`)
- Персистенс: `services/StorageService.ts` (localStorage, ключи `difit-storage-v1/<repositoryId>/<base>-<target>[-merge-base]`, отдельный индекс `difit-viewed-index-v1` с лимитом 5000 записей, миграция схемы v1->v2) и `services/userSettings.ts` (серверный конфиг, дебаунс 300 мс, `fetch` best-effort).

### Как фронт общается с бэком
Обычный `fetch` (без react-query/swr) + два `EventSource`:
- `GET /api/diff?base&target&baseMode&ignoreWhitespace` - App.tsx:710
- `GET /api/revisions` - App.tsx:857
- `GET /api/blob/*` - `useExpandedLines.ts:52`, `useFileLevelTokens.ts:25`, `ImageDiffViewer.tsx:21`, `MarkdownDiffViewer.tsx:719`, `NotebookDiffViewer.tsx:486`
- `GET /api/line-count/*` - `useExpandedLines.ts:79`
- `GET /api/generated-status/*` - `useLazyDiffRendering.ts:291`
- `GET/PUT /api/user-settings` - `services/userSettings.ts:14/47`
- `POST /api/open-in-editor` - App.tsx:1111
- **SSE** `GET /api/watch` - `hooks/useFileWatch.ts:42` (реконнект до 5 попыток с шагом 3 с; `reload` -> показывает `ReloadButton`, `commentsChanged` -> перечитывает треды)
- **SSE** `GET /api/heartbeat` - App.tsx:1031 (сервер по разрыву гасится)
- URL для SSE резолвится через `utils/eventSourceUrl.ts` (учитывает `VITE_DIFIT_API_URL` в dev)

Синхронизация комментариев (App.tsx:239-300, 904-1027) - нетривиальная: bootstrap `merge(server, local)` при смене контекста, оптимистичная блокировка через `baseVersion`/`version`, при конфликте сервер мержит и возвращает результат (клиент его принимает, выставив `skipNextCommentSyncRef`), а перед `beforeunload` - `navigator.sendBeacon('/api/comments', ...)`.

---

## 4. Каталоги `packages/`, `dev/`, `scripts/`

### `packages/vscode` - единственный подпакет
VS Code-расширение с **вшитым** difit (не требует установки npm-пакета).
- `src/extension.ts` - команды `difit.openReview` / `difit.stopReview`, кнопка в `editor/title`, status bar; определяет repo root через `git rev-parse --show-toplevel`, поднимает сессию на репозиторий (`Map<repoRoot, Session>`), парсит URL из stdout по `/difit server started on (https?:\/\/\S+)/i`, таймаут 30 с; настройка `difit.executablePath` для внешнего бинаря
- `src/server-entry.ts` - форкается расширением, импортирует `startServer` напрямую из `../../../src/server/server.js` с `keepAlive:true, openBrowser:false`, отвечает IPC `{type:'ready', url, port, isEmpty}`; при `process.on('disconnect')` - self-exit, чтобы не оставлять сирот
- `src/watcher-shim.ts` - подмена `@parcel/watcher`: нативные биндинги лежат в `dist/server/prebuilds/@parcel/watcher-<platform>-<arch>[-musl|-glibc]/watcher.node`, резолв через `detect-libc`
- `src/open-stub.ts` - заглушка пакета `open` (браузер открывает сам VS Code)
- `build.mjs` - esbuild-бандл; `assets/` (логотипы, favicon), `.vscodeignore`, свой `tsconfig.json`
- Скрипт корня: `pnpm run package:vscode`

### `dev/` - вынесенная логика dev-скрипта (JS + `.d.ts`, тестируется vitest)
- `dev-stdout.js` - `createCliStdoutProxy`: построчный парсер stdout CLI, ловит `🚀 difit server started on <url>` (regex `CLI_SERVER_URL_PATTERN`) чтобы стартовать Vite только после готовности API, глушит dev-шум (`Port N is busy...`), но пробрасывает вывод комментариев при завершении
- `dev-lifecycle.js` - `getCompileCloseExitCode(code, isShuttingDown)`
- `dev-stdout.d.ts`, `dev-lifecycle.d.ts` + тесты (включены в `vitest.config.ts: include`)

### `scripts/`
- `dev.js` - оркестратор `pnpm dev`: `tsc -p tsconfig.cli.json` -> `node dist/cli/index.js --no-open` (NODE_ENV=development, stdin проброшен) -> по обнаружению URL поднимает `vite --open` с `VITE_DIFIT_API_URL`; корректный shutdown по SIGINT/SIGTERM
- `measure-performance.js` - бенчмарк рендера через Playwright/chromium, размеры small/medium/large/xlarge (5/20/50/100 файлов), порт 3456
- `generate-large-diff.js` - детерминированный (seed `difit-performance-default-v1`) генератор синтетических диффов
- `compare-performance.js`, `merge-performance-results.js` - сравнение/агрегация результатов для CI (`.github/workflows/performance.yml`)
- `export-site-data.js` - генерирует `public/site-data/manifest.json` + `snapshots/*.json` + `blobs/` из реальных коммитов репо (использует собранный `dist/server/git-diff.js`) для демо-сайта GitHub Pages
- `get-changes-since-tag.sh` - changelog от последнего тега через `gh` + `jq`

### Прочее, релевантное задаче обертки
- `skills/difit/SKILL.md` и `skills/difit-review/SKILL.md` - готовые «скиллы» для агентов (устанавливаются `npx skills add yoshiko-pg/difit`); формат `--comment '{"type":"thread","filePath":...,"position":{"side":"new","line":{"start":36,"end":39}},"body":"..."}'`
- `.claude/skills/`, `.codex/skills/` - внутренние скиллы разработки/релиза
- `src/site/` + `vite.config.site.ts` - отдельный билд статического демо (`dist/site`), где `src/site/utils/staticApiBridge.ts` **патчит глобальный `fetch`**, эмулируя все `/api/*` эндпоинты поверх статических JSON - полезный образец, если нужен рендер MR без живого бэкенда
- `docs/structure.md` - архитектурный док, но **частично устарел** (упоминает `@octokit/rest`, не знает про `/api/watch`, `/api/revisions`, `/api/blob`, comment-imports, background-режим)
