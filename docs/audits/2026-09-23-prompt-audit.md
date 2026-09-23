# Аудит промптов Iva, 23.09.2026

Методика: `claude-api/shared/prompt-audit.md`, шаги 0–6. Шаг 7 (поведенческая проверка) не выполнялся:
модель не вызывалась. Поэтому каждое удаление в диффе остаётся гипотезой, которую нужно проверить живым ходом.
Претензии про 400 сверены с `shared/model-migration.md`, разделы «Migrating to Claude Fable 5.1 from
Claude Fable 5» (плюс базовый «Migrating to Claude Fable 5.1») и «Migrating to Claude Opus 5.5».
Кэш сверен с `shared/prompt-caching.md`, раздел «Silent invalidators».

Предложенный дифф: `docs/audits/2026-09-23-prompt-audit.diff`. `git apply --check` из корня репозитория
проходит: 11 файлов, 13 хунков, код выхода 0. В код ничего не применено.

## Допущения

**Область.** Всё, что уходит в модель текстом.

- Системный промпт: `agent/instructions.md`, `agent/instructions/*`.
- Описания инструментов `agent/tools/*.ts`.
- Скиллы `agent/skills/**`.
- Субагент `agent/subagents/planner`.
- Ночные промпты памяти: `scripts/memory/rollup.ts`, `scripts/lib/notice-policy.ts`,
  `scripts/memory/instructions/**`.
- Промпт утреннего дайджеста `scripts/daily-digest.ts`.
- `agent/vision.ts`.
- Сборка запроса к Claude: `agent/lib/claude-cli.ts`, `claude-admission.ts`, `model-provider.ts`,
  `agent/provider.ts`, `agent/agent.ts`.
- Инструкции для разработчика `CLAUDE.md` и `AGENTS.md`. Оба в `.gitignore`, но лежат в рабочем дереве.

Исключены `node_modules`, `.output`, `.eve`, `.claude/worktrees`, `.worktrees`, `.scratch`, `dist`.

**Целевая модель.** Основная цель `claude-fable-5-1`: это дефолт маршрута `MODEL_PROVIDER=claude`
(`agent/lib/model-provider.ts:98`, алиас `fable` в `claude-cli.ts:164`). Вторая цель `claude-opus-5-5`:
самая новая модель в коде, её добавили сегодня коммитом `c5e05934` (алиас `opus`, `claude-cli.ts:132-136`).
По API обе модели ведут себя одинаково по всем пунктам этого аудита: нет prefill, нет non-default sampling,
thinking только adaptive, forced `tool_choice` отвечает 400, thinking-блоки привязаны к модели и переписке.
Поэтому каждая находка проверена на обеих моделях.

**Важная оговорка про провайдеров.** Общий дефолт всей системы не Claude. Это `MODEL_PROVIDER=ollama` с моделью
`deepseek-v4-pro` (`model-provider.ts:57-58`, `219`). Тот же системный промпт, скиллы и описания инструментов
уходят и в DeepSeek (ollama/opencode), и в OpenAI `gpt-5.x` (codex), и в OpenRouter/custom. Этих провайдеров
на Anthropic SDK не переводим, они вне цели аудита. Оговорка при этом влияет на уверенность. Текст, который
устарел для Claude, может оставаться нужным DeepSeek, поэтому находки по тону и структуре промпта
(группа 1) не поднимаются выше medium. Перед принятием их хунков нужна живая проверка на обоих провайдерах.

**Как вызывается Claude.** Не через SDK. Iva запускает установленный Claude Code CLI (`claude -p`,
stream-json) с подменённым системным промптом (`--system-prompt-file`) и своими полями тела в
`CLAUDE_CODE_EXTRA_BODY` (`claude-cli.ts:356-374`). Ровно один запрос к API пропускает реле
`claude-admission.ts`, тело оно не меняет.

## Инвентарь (шаг 1)

| Поверхность | Файлы |
|---|---|
| Системный промпт, статика | `agent/instructions.md` (79 строк), `agent/instructions/10-map.md`, `15-skills.md` |
| Системный промпт, динамика на `turn.started` | `05-language.ts`, `20-core.ts` (CORE.md), `25-persona.ts` (PERSONA.md), `30-owner-rules.ts`, `40-open-failures.ts`, `now.ts` |
| Инструменты | `bash`, `glob`, `grep`, `memory_search`, `read_file`, `remind`, `tasks`, `web_fetch`, `web_search`, `write_card`, `write_file` |
| Скиллы | `web-research`, `morning-digest`, `documents`, `google-workspace`, `agent-browser`, `report-problem`, `rich-post`, `rich-replies`, `security-defense`, `telegram-userbot` (+`safety.md`), `update-recovery` |
| Субагент | `planner` (`instructions.md`, `outputSchema` в `agent.ts`) |
| Промпты по расписанию | `rollup.ts` `buildPrompt`/`dailyTask`, `notice-policy.ts` `memoryReportTail`, `daily-digest.ts:31-36`, `memory-processor/**`, `autograph/docs/SKILL.md` |
| Vision | `agent/vision.ts` `PROMPT` / `PROBE_PROMPT` (только для провайдеров, у которых нет своего зрения) |
| Сборка запроса | `claude-cli.ts` (`claudeExtraBody`, `claudeWarnings`, `claudeHistory`, `sealFrames`, `assistantBlocks`, `finishOf`), `claude-admission.ts`, `provider.ts` (`withReasoningStripped`), `agent.ts` |
| Инструкции для разработчика | `CLAUDE.md`, `AGENTS.md` |

## Происхождение (шаг 2)

`git blame` по спорным местам.

- `web-research.md:7-15`, `agent-browser/SKILL.md:13-15` написаны 20.06.2026 (`365e136e`).
- `morning-digest.md:20` написан 18.06 (`b4517595`), `planner/instructions.md` тоже 18.06 (`e4a9f74e`).
- `now.ts` написан 20.06 (`5721cdfa`), «3-5 short lines» в `notice-policy.ts` появился 13.08 (`34cf6dfd`).

Всё это старше маршрута Claude: его добавили 22.09 коммитом `eafbae00`. Значит, эти тексты писались под
DeepSeek, а на Claude достались по наследству. Карта `instructions.md:27-39` и `remind.ts:131-144` свежие
(12.09 и 12-17.09). Они не смягчают слабость старой модели, а отражают дизайн «карты» (`bfc3ecfd`).

## Сводка

| Группа | high | medium | low |
|---|---|---|---|
| 1. Устаревший текст промпта | 0 | 5 | 7 |
| 2. Скиллы и файлы правил | 1 | 0 | 4 |
| 3. Описания инструментов | 0 | 2 | 1 |
| 4. Конфиг запроса и архитектура | 3 | 2 | 1 |
| **Итого** | **4** | **9** | **13** |

В дифф вошли 9 находок (13 хунков): все high и medium с действием rewrite/remove, кроме четырёх пунктов
группы 4. Эти четыре требуют правки кода или решения о цене, поэтому описаны в таблице без хунка.

**Три самые важные находки.**

1. **Время с точностью до минуты в системном промпте** (`agent/instructions/now.ts:49-56`). Строка
   пересобирается на каждом ходу, поэтому system меняется каждый раз, когда владелец пишет. Кэш промпта
   (его ставит CLI) промахивается на всю историю сессии, а сессия живёт до 24 часов. Для Fable 5.1 кэш-чтение
   стоит 0.025x от входа, так что каждый промах обходится особенно дорого. У eve уже есть готовая замена:
   инструкция `role: "user"`, которая дописывается в историю перед репликой и не трогает префикс.
   Это хунк 1.
2. **Thinking-блоки выбрасываются из истории на каждом шаге** (`agent/agent.ts:24`,
   `claude-cli.ts:507-509`). Руководство по миграции называет полную зачистку thinking разовым
   восстановлением, а не постоянным режимом. Постоянная зачистка теряет рассуждение между шагами
   tool-loop и каждый раз заново запускает кэш. 400 это не вызывает, потому что вырезаются все блоки
   целиком. Исправление архитектурное (ADR), поэтому хунка нет.
3. **Отказ `refusal` выдаётся за обычный ответ** (`claude-cli.ts:1388-1394`, `1508-1514`).
   `stop_reason: "refusal"` превращается в `unified: "stop"`. Если отказ пришёл посреди стрима, частичный
   текст уходит владельцу как готовый ответ, а резервной модели нет. Руководство требует для Opus 5.5
   ([BLOCKS]) и для Fable 5.1 сначала обработать refusal и включить fallback. Включение fallback — решение
   о цене, поэтому хунка нет.

**Проверено и не является находкой** (претензии из постановки).

- `claude-cli.ts:214-222` (`temperature`, `topP` и т.д.). Это список полей, которые **отбрасываются**
  с предупреждением (`claudeWarnings`, `:377-387`). В тело запроса они не попадают. Для Fable 5.1 и
  Opus 5.5 это верное поведение: «no non-default sampling parameters».
- `claude-cli.ts:371-372` (`stop_sequences`). Поле пробрасывается, только если его задал вызывающий,
  а ни один вызывающий в `agent/` и `scripts/` его не задаёт (проверено grep). В разделах про Fable 5.1
  и Opus 5.5 `stop_sequences` не объявлен устаревшим и JSON здесь не охраняет. Всё чисто.
- `claude-cli.ts:413`, `:470` (prefill). Это **защита**: `sealFrames` бросает ошибку, если история
  кончается ассистентом. Ни одна ветка не порождает завершающий assistant-ход. Всё чисто.
- `thinking`: отправляется только `{type: "adaptive"}` (`:364-368`). Ни `disabled`, ни `budget_tokens`
  не отправляются. У Haiku 4.5 thinking выключен верно (`adaptive: false`).
- `tool_choice` кроме `auto` отбрасывается с предупреждением (`:391-396`), поэтому forced tool use
  не вызывает 400.
- Обратный отсчёт бюджета выключен: `CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off"` (`:104`).
  Учёт токенов есть (`agent/hooks/usage.ts` и строка `report()` с cache read/write).

## Находки

Порядок по уверенности. «Хунк» означает, что правка есть в `.diff`.

### High

| # | Место | Цитата | Паттерн | Почему устарело | Действие |
|---|---|---|---|---|---|
| H1 | `agent/instructions/now.ts:49-50`, `:56`; `agent/instructions.md:56`; `scripts/timezone-contract.test.ts:101` | `` `Текущая дата и время пользователя: ${formatted}…` `` при `"turn.started": () => defineInstructions({ markdown: nowMarkdown() })` | Гр. 4, кэш-враждебный порядок (`prompt-caching.md` → Silent invalidators: «`Date.now()` in system prompt») | Системная инструкция с минутами меняет system на каждом ходу. Промпт-кэш промахивается на всю историю сессии (до 24 ч), а на Fable 5.1 промах относительно дороже (0.025x). eve (`node_modules/eve/docs/instructions.mdx`, раздел System and user roles) дописывает user-инструкцию в историю перед репликой, не трогая префикс | rewrite, **хунк**: `defineInstructions({ content: nowMarkdown(), role: "user" })`, комментарий в `now.ts`, строка в `instructions.md:56`, тест `result.markdown` → `result.content` |
| H2 | `agent/agent.ts:24`, `agent/provider.ts:804` (`withReasoningStripped`), `agent/lib/claude-cli.ts:507-509` | «Рассуждение в историю не возвращается: его режет withReasoningStripped» | Гр. 4, harness редактирует историю | `model-migration.md`: «pass thinking blocks back unchanged», «Pass `thinking` blocks back unmodified in tool-use loops» (Opus 5.5, BC1 п.4). Полная зачистка допустима как «one-time recovery, not a steady-state pattern». Если делать её на каждом запросе, теряется рассуждение и каждый раз заново запускается кэш. Реле захватывает `thinking`/`signature` (`claude-admission.ts:256-257`), но в eve они не попадают. Зачистку вводили против бага DeepSeek (`provider.ts:765-771`), а на Claude она прилетает заодно | flag: вне текстового диффа. Предложение для ADR: на маршруте claude не оборачивать модель `withReasoningStripped`, отдавать thinking-блоки reasoning-частями с `signature` в `providerMetadata` и собирать их обратно в `assistantBlocks` без изменений |
| H3 | `agent/lib/claude-cli.ts:1388-1394`, `:1508-1514` | «Отказ модели (`refusal`) — тоже ответ, и он уезжает владельцу как есть»; `finishOf` → `{ unified: "stop" }` | Гр. 4, API: `refusal` stop reason | Fable 5.1: «handle before reading content… mid-stream… discard the partial output rather than treating it as complete». Opus 5.5, чек-лист [BLOCKS]: «Handle `stop_reason: "refusal"`… ship a fallback opt-in». Сейчас частичный текст считается законченным ответом, fallback нет | flag: код и решение о цене. Сопоставить `refusal` с `unified: "content-filter"`, частичный текст не отдавать как ответ. Fallback (`claude-opus-4-8` / `claude-opus-5`) включать только после «ок» владельца |
| H4 | `CLAUDE.md:80` | «скилл `quality-gate` (`~/.claude/skills/quality-gate/SKILL.md`…)» | Гр. 2, устаревшие конкретные значения | Проверено: `~/.claude/skills/quality-gate` нет, скилл живёт в `~/.claude/skills/code-quality/SKILL.md`. Агент, который идёт по этой строке, не найдёт инструмент замера | rewrite, **хунк**: путь и имя → `code-quality` |

### Medium

| # | Место | Цитата | Паттерн | Почему устарело | Действие |
|---|---|---|---|---|---|
| M1 | `agent/instructions.md:27-39` | «- tasks → `tasks` / - reminders → the `remind` tool … / - MCP → `connection_search` / - memory → … `memory_search`» | Гр. 3, имена инструментов в системном промпте, список-тень реального tool list | Контракт инструмента живёт в его описании. Если инструмент выключен (например, нет подключений), в промпте остаётся висячая ссылка. Маршруты на скиллы и субагента это текст-маршрутизатор, его оставляем (keep-list п.6) | rewrite, **хунк**: убраны маршруты к инструментам, оставлены скиллы, `planner`, «Memory map (MAP)», «CORE» |
| M2 | `agent/skills/web-research.md:7-15` | «1. **Поиск.** … 2. **Отбор.** Выбери 2–4 … 4. … ОБЯЗАТЕЛЬНО укажи ссылки-источники» | Гр. 1c, пошаговый сценарий для задачи на суждение; 1a, капс; 1f, число | Fable 5.1 и Opus 5.5 сами планируют поиск («De-prescribe migrated prompts», Fable 5.1 long-running recommendations). Капс без причины и «2–4» писались под DeepSeek 20.06 | rewrite, **хунк**: цель и ограничения прозой. Требование ссылок оставлено с причиной, предупреждение про `agent-browser` и данные оставлено |
| M3 | `agent/skills/morning-digest.md:20` | «Держи дайджест компактным: максимум 5–7 пунктов.» | Гр. 1f, числовой потолок вывода | Ограничения по числу строк или пунктов снимаются вместе. Следующее предложение («покажи самые важные и упомяни, сколько ещё осталось») уже выражает цель | rewrite, **хунк** |
| M4 | `scripts/lib/notice-policy.ts:93-95`; тест `scripts/lib/notice-policy.test.ts:86` | «return a SHORT report … 3-5 short lines» | Гр. 1f, числовой потолок, плюс 1a, капс | Операционная причина (отчёт в чат) не делает число полезным: цель выражается через читателя | rewrite, **хунк**: «short enough to read at a glance in a chat», тест переведён на новую формулировку |
| M5 | `agent/skills/agent-browser/SKILL.md:13-15` | «## ВАЖНО — начни отсюда / ПЕРЕД любой работой с браузером загрузи … (всегда под версию CLI)» | Гр. 1a, повышенный тон | Требование настоящее: версия CLI. Но капс раздувает его. Текущие модели буквально следуют спокойной формулировке с причиной | rewrite, **хунк**: тот же порядок нормальным тоном, причина явно |
| M6 | `agent/subagents/planner/instructions.md:4`, `:11` | «разбить её на 3–7 … шагов»; «Не выдумывай шаги ради числа. Если цель маленькая — хватит и трёх.» | Гр. 1f, число; 1d, заплата поверх заплаты | Вторая строка лечит вред первой. Число шагов должно зависеть от цели | rewrite, **хунк**: «столько, сколько цель реально требует», заплата удалена |
| M7 | `agent/tools/remind.ts:133-138` | `'{"action":"add","text":"позвонить","at":"in 30m"}'`, `'{"action":"list"}'`, `'{"action":"remove","id":"r-1a2b3c"}'` | Гр. 3, примеры вызова в описании | Схема (`z.enum` и описания параметров, где у `at` уже есть примеры) несёт контракт. JSON-примеры в описании ездят в каждом запросе и сужают пространство вызовов | rewrite, **хунк**: примеры убраны, контракт (время словами пользователя, `next_run_at`, id из list, адресат, запрет своих таймеров) сохранён |
| M8 | `agent/lib/claude-cli.ts:364-368`; `.env.example:74` (`THINKING_EFFORT=` пусто) | `if (effort !== undefined) body.output_config = { effort };` | Гр. 4, effort под другую модель | Opus 5.5: «The API default is `medium` … Set `effort` explicitly». При пустом `THINKING_EFFORT` alias `opus` работает на `medium`, а `fable` на `high`: переключение модели молча меняет глубину | flag: выбор дефолта это цена и задержка, решает владелец. Вариант: мастер `/model` пишет явный `THINKING_EFFORT` при выборе Claude |
| M9 | `agent/skills/morning-digest.md:9-13`; `scripts/daily-digest.ts:31-36` | «Сгруппируй задачи: Просроченные / на сегодня — у которых `due` сегодня или раньше …» | Гр. 4, LLM исполняет детерминированный план; 1b, арифметика в модели | Группировка по сроку и приоритету полностью определяется данными `tasks`. Суждения требует только строка «фокус дня» | move без хунка: нужна правка кода `tasks` (флаги `overdue` и `today` в `list`) и тестов. `due` сейчас в свободной форме, это тоже решение |

### Low (только в отчёте, в диффе нет)

| # | Место | Цитата | Паттерн | Комментарий |
|---|---|---|---|---|
| L1 | `agent/instructions/10-map.md:26,27,30,33,68,86,88,91` | «ALREADY in context», «READ FIRST», «INSTEAD», «RAW», «do NOT run manually», «DIRECTLY», «NOT a vault-relative one», «Do NOT write» | 1a | Почти у каждого есть причина рядом. Промпт общий с DeepSeek, поэтому только флаг |
| L2 | `10-map.md:36-52`, `:51` | «How to recall (step by step)», «5. Stop early.» | 1c | Порядок здесь это лестница стоимости (саммари дешевле сырья), его оставляем. «Stop early» похоже на совет по стратегии |
| L3 | `agent/instructions.md:22-25` | «If you do not know or cannot do something, say so plainly.» | 1c, пересказ поведения по умолчанию | Безвредно |
| L4 | `agent/instructions.md:6` | «## Delivery - read first» | 1a | На заголовок `## Delivery` завязан тест `rollup-notices.test.ts:100`, «read first» можно снять |
| L5 | `scripts/memory/rollup.ts:173` | «Do not invent facts — take them from the source files.» | 1c, `do not hallucinate` | Методика прямо ставит low: вред удаления не задокументирован |
| L6 | `agent/skills/google-workspace.md:12` | «## Проверка авторизации (ВСЕГДА первым делом)» | 1a | Заголовок противоречит телу, которое велит реагировать на код выхода 2, а не проверять заранее |
| L7 | `scripts/memory/instructions/memory-processor/SKILL.md:8-9` | «Model-agnostic — runs on any LLM … (Iva uses DeepSeek)» | 2, модель прибита в тексте | С 22.09 ночной проход может идти и на Claude |
| L8 | `scripts/autograph/docs/SKILL.md` (374 строки) | весь файл | 2, SKILL.md не читается за раз | Это справочник, который грузится по ссылке, а не каждый ход |
| L9 | `AGENTS.md:60` | «`createVersionUpdateCommand`, scripts/cli/version-update-command.ts:202 … update-finish.ts:792» | 2, номера строк | Сегодня все три ссылки верны (проверено), но при правках они будут протухать |
| L10 | `CLAUDE.md:78-85` | «Метрики кода (замер 18.09.2026, main c7b55963…)», «13 красных, причина не установлена» | 2, снимок состояния | Это контекст от автора, по методике не мусор, но он устаревает. Место ему в отчёте замера, на который раздел и ссылается |
| L11 | `agent/tools/write_card.ts:619-621` | «для карточек — ЭТО, не write_file», «Summary … НЕ создавай» | 3, перекрёстный запрет | Код и так исполняет правило (`write_file` отказывает на карточке) |
| L12 | `agent/lib/claude-cli.ts:397-405`; `agent/subagents/planner/agent.ts:20` | «Claude by subscription answers in text, not in a given schema» | 1b, JSON через prose/forced tool → structured outputs | `output_config.format` можно передать тем же `CLAUDE_CODE_EXTRA_BODY`, что и `effort`. Пропускает ли его CLI, без живого вызова не проверить. До проверки строку «Верни строго структуру» в `planner` оставляем |
| L13 | `agent/instructions/40-open-failures.ts:15` | системная инструкция на `turn.started` | 4, кэш | Меняется только при новом провале, так что промах кэша редкий. Для однотипности можно перевести в `role: "user"` так же, как H1 |

Не применимо к цели: `agent/vision.ts:11-13` (OCR-проход перед чатом, гр. 1d). На маршруте claude
`chatModelSeesImages()` возвращает `true` без запроса (`vision.ts:241`), и картинка идёт прямо в модель.

## Что делать с диффом

- Хунки независимы, кроме трёх хунков H1: `now.ts`, `instructions.md:56` и `timezone-contract.test.ts`
  берутся вместе.
- Тесты не запускались, потому что код не менялся. После применения нужны тронутые тест-файлы:
  - `node --test scripts/timezone-contract.test.ts scripts/lib/notice-policy.test.ts scripts/remind-tool.test.ts scripts/memory/rollup-notices.test.ts`;
  - `npm run typecheck`;
  - `npm run build`, потому что правки в `agent/` работают только после сборки.
- Prettier на изменённых `.ts` проверен и совпадает.
- Шаг 7 методики (проверка поведения до и после) не выполнялся по условию задачи. Хунки M1-M7 нужно
  проверить живым ходом на Claude и на DeepSeek. Второе обязательно, потому что текст общий.
