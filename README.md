<p align="right"><b>EN</b> · <a href="./README.ru.md">RU</a></p>

<div align="center">

<img src="assets/iva-header.webp" alt="Iva — self-hosted Telegram AI assistant with layered memory" width="100%">

[![Release](https://img.shields.io/github/v/release/smixs/iva-agent?color=brightgreen)](https://github.com/smixs/iva-agent/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![built on eve](https://img.shields.io/badge/built%20on-eve-000000?logo=vercel&logoColor=white)](https://eve.dev/docs/introduction)
[![Node 24](https://img.shields.io/badge/node-24.x-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Last release](https://img.shields.io/github/release-date/smixs/iva-agent?label=last%20release&color=informational)](https://github.com/smixs/iva-agent/releases)

[Site](https://iva-agent.com) · [Use cases](#why-people-run-iva) · [Features](#features) · [Install](#install) · [Memory](#the-memory-tree) · [What's new](#whats-new) · [Docs](#documentation)

</div>

---

Iva is a self-hosted Telegram AI assistant with layered memory that turns your messages into an Obsidian-compatible vault. You talk, it files: voice notes, photos, forwarded posts and decisions become plain-markdown cards it actually remembers. Everything runs on your own server, with your keys and your data.

**One command installs it:**

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
```

## Why people run Iva

- "What did we agree with client X about the last shipment?" — found in seconds, months later.
- A five-minute voice note from the car → a task list, a draft email, a meeting card.
- "Make a quote from this price list, cut the discount by 2.5%, send it to the client" — a finished Google Doc, link in the chat.

The rest — for business owners, specialists, executives and everyday life: **[Use cases](docs/use-cases.md)**.

## How it works

<img src="assets/iva-flow.webp" alt="How Iva works: voice, text, photos and PDFs fly from Telegram into the willow-tree agent, wired to memory, nightly rollup, cron, reminders, search, web, workspace and docs" width="100%">

The bridge long-polls Telegram, so no public HTTPS, domain or webhook is needed. Iva runs as two systemd user services, two systemd watchdog timers and seven in-process eve schedules — operations live in [docs/deploy.md](docs/deploy.md).

**Wondering what you'd actually use an agent for?** → [25+ real scenarios — business, work, everyday life](docs/use-cases.md).

<img src="assets/iva-use-cases.webp" alt="What people ask Iva: eight everyday requests, from a voice note turned into tasks to research with sources and a bedtime story that continues tomorrow" width="100%">

## Features

<details>
<summary><b>Voice, vision, memory, personal CRM, Google Workspace, skills — expand the full list</b></summary>

- **Voice** — voice, audio and video notes transcribed with Deepgram nova-3; auto-detects ru/uz/en.
- **Vision** — photos described by your provider's own vision model; no extra key, no extra bill.
- **Rich replies** — tables, checklists, collapsible blocks and formulas render natively in Telegram via Bot API 10.1 rich messages; plain formatting keeps its proven path, with a graceful fallback.
- **Quiet update checks** — once a day Iva checks for a newer stable release without spending model tokens. If one exists, Telegram offers **Update** or **Later** once; otherwise it says nothing.
- **Layered memory** — remembers across months, long after the chat window has scrolled away.
- **Personal CRM** — who your people are, what you agreed, when to follow up.
- **Search by meaning** — BM25 plus link-graph rerank, any language; optional vector mode with one key.
- **Decision cards** — what you chose, when and why; old versions stay in a dated History.
- **Tasks & reminders** — priorities, due dates and a morning digest.
- **Web search** — four pluggable providers: Tavily, Exa, Parallel or Brave.
- **Google Workspace** — Gmail, Calendar, Drive, Sheets, Docs and Tasks from chat via the `gws` CLI; installed for you, with a guided key setup right in the conversation.
- **Skills & MCP** — drop one file to add a procedure or connect an MCP server; keys stay in `.env`.
- **Personal Telegram — userbot (beta)** — read and send from your _own_ account, not just the bot; connect by chat (QR, no terminal). Rough and buggy — opt-in, **at your own risk**. A server-side anti-ban guardrail (FloodWait compliance + randomized pacing + circuit-breaker) is enforced, not just advised. [Details](docs/userbot.md).
- **Safe to forward** — forwarded text, captions and voice transcripts pass an injection screen before the model reads them. A flagged message or transcript reaches the model tagged as data rather than as an instruction; for media captions the screen runs but the tag does not travel with it yet.
- **Token accounting** — every model step is logged; `/usage` reports it for free.

</details>

## The Memory Tree

<img src="assets/iva-memory-tree.webp" alt="How Iva remembers: a leaf is a day, branches are weeks and months, tree rings are years around CORE.md" width="100%">

| Layer       | What lives there                                                                                    | Path                                                 |
| ----------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 🍃 Leaves   | the word-for-word transcript of each day, Iva's replies included                                    | `daily/YYYY-MM-DD.md`                                |
| 🌿 Branches | summaries folded upward: day → week → month → year                                                  | `summaries/daily/`, `weekly/`, `monthly/`, `yearly/` |
| 🪵 Trunk    | `CORE.md` (≤1200 chars, in every prompt) + typed cards: contacts, projects, decisions, ideas, notes | `CORE.md`, `cards/`                                  |

- Every message lands verbatim in a daily markdown log — nothing is paraphrased on arrival.
- A nightly rollup at 04:00 distills day → week → month → year into schema-validated cards; facts that change get rewritten, not piled up.
- One core file, `CORE.md` (≤1,200 chars), rides in every prompt — Iva knows you before it searches anything.

Full architecture and search internals: [docs/memory.md](docs/memory.md).

## A secretary inside Telegram

<img src="assets/iva-userbot.webp" alt="Your secretary inside Telegram: the userbot reads group chats from your own account, collects summaries and replies as you, guarded by a server-enforced anti-ban guardrail" width="100%">

The bot is half of Telegram. The other half is your personal account: connect the userbot (beta, opt-in) and Iva works from it like a secretary — reads the group chats you never keep up with, folds them into summaries, catches the messages that actually need you, and replies as you.

- **All of Telegram** — groups, channels, unreads, search and the full history of your personal account.
- **Onboarding in chat** — tell the bot to connect your Telegram, scan a QR. No terminal.
- **Anti-ban guardrail on the server** — FloodWait compliance, a randomized delay after every send, and a circuit-breaker that pauses sending after three FloodWaits in 24 hours. It is enforced in the proxy rather than asked for in a prompt, and it wraps the three outbound calls that actually get accounts flagged: messages, files, forwards. Joins, invites, contact imports and reactions are not wrapped — those limits live in the skill file, which is a prompt.
- **Read-only mode** — one `.env` switch and Iva can read and search but physically cannot send.

> [!WARNING]
> Automating a personal account is against Telegram's ToS and can get the account limited or banned. The userbot is opt-in, beta, and used at your own risk — reading is far safer than sending. Details: [docs/userbot.md](docs/userbot.md).

## Security & privacy

<img src="assets/iva-security-gate.webp" alt="Untrusted input from Telegram and the web passes the security gate: corrupted messages drop into the reject tray, only clean context reaches the vault" width="100%">

Web pages, search results, voice transcripts, captions and the vision model's description of a picture reach the model only through a prompt-injection sanitizer. On a forwarded text message the same gate annotates the turn with a warning instead of filtering the text, and document bodies, userbot-read chats and `agent-browser` output are not screened at all. Everything that leaves through the Outbox passes a secret-redaction gate, and the user allowlist fails closed — an empty list answers nobody. Your memory is a private git repo you own; the honest boundary is that the model and transcription are cloud APIs you choose and pay for. Gate internals and the full boundary: [docs/security.md](docs/security.md).

## Install

One command on any Ubuntu/Debian box — a fresh VPS or your own machine:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
```

1. Get a bot token from [@BotFather](https://t.me/BotFather).
2. Run the installer and answer its questions.
3. Message your bot. The wizard picks your Telegram ID out of that message, finishes setup, and Iva confirms right in the chat that it's live.

Brand-new VPS, still logged in as root? Run `bash <(curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/bootstrap.sh)` first: it creates your sudo user (with lingering enabled), updates the box, and turns on a firewall, fail2ban and SSH hardening. It asks three things — a login, its password, and the timezone — and no SSH key. Then log in as that user with that password and run the installer above. Details: [docs/install.md](docs/install.md).

Install as a normal user, not as root — Iva's shell tool runs as whoever installed it. Headless installs take `--skip-setup` or `--non-interactive`. Prefer to read before you run? Fetch it with `curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh -o install.sh`, read it, then `bash install.sh`. Wizard walkthrough and an SSH primer for first-time VPS owners: [docs/install.md](docs/install.md).

### The first minute

Three messages, and you can watch the memory work:

1. Send a voice note about your day — anything, out loud. Then look in `daily/` inside your vault on the server: your words are sitting there in plain markdown, dated, yours. No other assistant hands you the file.
2. Tell it something a colleague would remember: `Marina at Acme wants the revised quote by Friday — she never picks up the phone.`
3. Ask for it back the way a person would: `how should I follow up with Marina?` — the answer comes from the card Iva just wrote, not from the last few messages.

Then send a photo of a business card, or forward a long post and ask for the gist. `/menu` has the rest; the full list is in [25+ scenarios](docs/use-cases.md).

<details>
<summary><b>Install from a clone — build it yourself</b></summary>

```bash
git clone https://github.com/smixs/iva-agent.git ~/iva
cd ~/iva && bash install.sh
```

The installer reuses the existing checkout instead of re-cloning, keeps `.env` and the vault untouched, and installs the same dependencies. A fork or a branch works through variables read at startup: `REPO_URL=…`, `BRANCH=…`, `INSTALL_DIR=…` (defaults: this repo, `main`, `~/iva`). Details: [docs/install.md](docs/install.md).

</details>

## Providers & cost

Five model providers. Pick one and fill its block in `.env`:

| Provider         | How you pay                            |
| ---------------- | -------------------------------------- |
| OpenCode Go      | API key, ~$10/mo ($5 first month)      |
| Ollama Cloud     | API key, ~$20/mo                       |
| OpenRouter       | API key, pay-as-you-go, 300+ models    |
| OpenAI (ChatGPT) | your Plus/Pro subscription, no API key |
| Custom           | your own OpenAI-compatible endpoint    |

Default model is deepseek-v4-pro, 131k context. On Go it runs about $14–15/mo all-in ($10 model + $4–5 VPS; the model's first month is $5), no markup; voice rides Deepgram's free starter credit. Model lists, limits and the search matrix: [docs/providers.md](docs/providers.md).

## Documentation

[Use cases](docs/use-cases.md) · [Install](docs/install.md) · [Configuration](docs/configuration.md) · [Memory](docs/memory.md) · [Providers](docs/providers.md) · [Security](docs/security.md) · [Deploy](docs/deploy.md) · [Commands & CLI](docs/cli.md) · [Menu](docs/menu.md) · [Reminders](docs/reminders.md) · [Extending](docs/extending.md) · [Plugins](docs/plugins.md) · [FAQ](docs/faq.md) · [Troubleshooting](docs/troubleshooting.md)

Документация на русском → [docs/ru/](docs/ru/)

## What's New

<details>
<summary><b>v0.4.5 · 21.09.2026 — expand the latest releases</b></summary>

### 21.09.2026

#### v0.4.5

- ⏹ **Stop kills the work at once, not just the talk with the model**: the `bash` tool ignored a cancelled turn, so "Stop" ended the model request while the command it had started kept running. Now a stop kills the whole process group immediately, and the web search and embedding requests of the turn are aborted with it.
- ⏹ **Stop always arrives and tells the truth**: the button and `/stop` no longer answer "nothing is running" to a turn that has been silent for half an hour, the bridge keeps reading messages while it waits for the confirmation, and "Stopped" is said only after the agent confirmed it.
- 🔁 **A turn that did not stop gets a "Restart Iva" button**: if no confirmation comes within a minute, the owner gets an honest message in the private chat with a button that restarts the service; Iva never restarts herself on her own.
- ⏰ **A reminder turn has no time cap any more**: the turn was cut at the eighth minute and its process killed at the tenth, so long scheduled jobs never finished. Now it runs as long as events keep coming; three minutes of silence or the owner's `/stop` end it, and a stopped turn sends nothing.
- 🔎 **Memory finds a card by another spelling**: `write_card` takes `aliases` (up to 8 spellings: Cyrillic and Latin, transliteration, the everyday name), search ranks them highest, and the tool descriptions no longer promise word forms the index does not catch.
- 🧾 **A fact in a card never changes silently**: an update with a new `description` used to erase the old value without a trace. Now the previous value goes to `## History` in a line dated by code only; swapped numbers and names, a changed sign or a negation count as a change of fact, case and spacing do not.
- 🗂 **Every memory write is its own commit in the vault's git**: `write_card`, `write_file` inside the vault and `CORE.md` edits each leave a commit with exactly their own paths, so one broken card can be reverted. Someone else's uncommitted work is never swept in, the commit goes only to the vault's own repository, a git failure never fails the write, and Brain commits without a remote too.
- 🩹 **The "iva repair" advice is replaced with a command that exists**: the nightly alert about unreadable files now advises `iva update --force`.

### 17.09.2026

#### v0.4.4

- ⏰ **A reminder is an instruction Iva gives her future self**: at the due minute the text of the reminder is the prompt of one fresh turn with tools, not a line to read back — "in 3 minutes find the news and send it" arrives as the news, not as its own wording. A turn that could not run, failed or came back empty still delivers: the code sends your text verbatim and names the cause in the row.
- ⏰ **A reminder comes back to the chat it was asked in**: the row remembers the chat and the topic of the turn, so a reminder set in a group topic lands in that topic instead of a private chat; old rows and requests that did not come from Telegram still go to the owner's chat. `iva doctor` stopped claiming "the dispatcher has not ticked yet" — it was reading the pulse from the wrong folder.
- 🔁 **`/update --force` works from the chat too**: the word after `/update` is read now, so the running build can be rebuilt from Telegram exactly as `iva update --force` does on the server — the way out of a broken edit in Iva's own code. The flag travels in the request file, so a restarted update rebuilds as well.
- 🩺 **The doctor names the cure for stuck workflows**: "running count 7 exceeds 5" now says in the same line that such runs are stale rather than live, and that `iva reset` quarantines them and restarts the services; memory is left alone.

### 14.09.2026

#### v0.4.3

- 🔁 **One updater, the way pi does it**: the old in-place update path (stash and rebase inside the working folder with a byte-level check of stray files, ~15k lines) is gone together with the guesswork "developer or installation" by branches and shims that kept people with a second branch on the fragile path forever. Every Iva folder now updates through versions: build beside, probe, switch, roll back. A developer checkout is marked with an empty `.iva-dev` file. Edits to Iva's own code are no longer promised or kept — your own skills, tools and plugins live in `data/custom`. `repair.sh` and a re-run of `install.sh` hand an existing installation to the same updater. An update cut off mid-way (a server reboot) is restarted once by the bridge itself with a line in the chat. Older flat installs need two `/update`s: the first fetches the new code, the second moves onto versions.
- 🔘 **Menu buttons two per row again**: the classic menu lays buttons out in pairs as before 0.4.2; the new rich menu shows the same pairs as compact pills with a "button — what it does" caption under the row, no more one long full-width button.
- 🔌 **A tool schema the provider rejects no longer kills the turn**: OpenAI (codex) rejects the whole request when any tool carries a regex with lookaround; Iva now retries once without those patterns, and if it still fails, the error names the field and where the tool lives.
- 🧷 **Codex tools without strict mode**: tools go to codex with `strict: false`, so optional fields stay optional and reminders are set on the first call instead of looping.
- 🧰 **`diagnose.sh` collects more**: the plugin list, the reminder dispatcher pulse and the schedule lines of the last day.

</details>

Full history — [CHANGELOG.md](CHANGELOG.md).

## Built on

[eve](https://eve.dev/docs/introduction) 0.51.1, Vercel's agent framework, runs the agent; Node 24's built-in SQLite runs the search index — no separate database. Iva grew out of [agent-second-brain](https://github.com/smixs/agent-second-brain) and [autograph](https://github.com/smixs/autograph) — that story is in [docs/memory.md](docs/memory.md).

## Thanks

Iva gets better because people run it for real — contributors are welcome. [Open an issue](https://github.com/smixs/iva-agent/issues) with what breaks, or send a PR. Everyone who already helped: [docs/thanks.md](docs/thanks.md).

## License

[MIT](LICENSE) — take it, change it, run it on a hundred servers; just don't blame anyone if something breaks.
