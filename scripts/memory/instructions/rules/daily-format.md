---
paths: "{daily,summaries/daily}/**/*.md"
---

# Daily format & daily-summary (rollup chain, levels 0–1)

Covers two file kinds at the bottom of the rollup chain:

- **Raw transcript** — `daily/YYYY-MM-DD.md` (append-only conversation log).
- **Daily-summary** — `summaries/daily/YYYY-MM-DD.md` (type `daily-summary`).

Navigation flows `yearly → monthly → weekly → daily-summary → raw transcript`.
The daily-summary is the only thing that links _into_ the raw transcript.

## Raw transcript — `daily/YYYY-MM-DD.md`

One file per day, named `YYYY-MM-DD.md` in the user's timezone. Two-sided log written
live by the Telegram channel and Iva's transcript hook.

```markdown
## HH:MM [type]

Content of the entry
```

### Entry types

| Type                   | Side | Description                                           |
| ---------------------- | ---- | ----------------------------------------------------- |
| `[text]`               | user | Direct text message                                   |
| `[voice]`              | user | Transcribed voice message                             |
| `[video]`              | user | Transcribed video / video-note                        |
| `[photo]`              | user | Image (Obsidian embed + any caption)                  |
| `[forward from: Name]` | user | Forwarded message with source                         |
| `[iva]`                | Iva  | Iva's final reply (older days may use legacy `[eva]`) |

### Append-only rules

1. **Never modify** existing entries — no edits to content, timestamps, or order.
2. **Never insert** content between entries.
3. The processor appends **only** processing markers at the very end: a part marker
   `<!-- processed-through: HH:MM -->` after each finished part of a large day (HH:MM is
   the heading of the part's last entry; the rollup resumes after the last one), and,
   when the day is done, the processed marker. The markers are the file's last lines; only
   the processed marker makes the day done, and a marker quoted inside an entry does not
   count (the transcript writes an entry line that starts with `<!--` as `&lt;!--`):
   ```markdown
   <!-- processed: YYYY-MM-DDTHH:MM -->

   ---

   processed: YYYY-MM-DDTHH:MM
   cards: <N>
   summary: summaries/daily/YYYY-MM-DD.md
   ---
   ```

## Daily-summary — `summaries/daily/YYYY-MM-DD.md`

Produced by the `memory-processor` skill after processing the day.

```markdown
---
type: daily-summary
date: YYYY-MM-DD
description: >-
  One-line gist of the day.
tags: [daily, <topic>, <topic>]
status: active
topics: [topic-a, topic-b, topic-c]
source: daily/YYYY-MM-DD.md
---

# YYYY-MM-DD

## Topics

- **Topic A** — one line.
- **Topic B** — one line.

## Highlights

- The few things that mattered.

## Cards created today

- [[cards/<kind>/<slug>|Card title]]
- (none)

## Navigation

- Raw transcript: [[daily/YYYY-MM-DD|Full transcript]]
- Up: [[weekly/YYYY-Www|Week WW]]
```

### MOC contract (daily-summary)

- **topics** — in `topics:` frontmatter and `## Topics` (read by the weekly rollup).
- **down → cards** — link every card created/updated today.
- **down → raw** — link `daily/YYYY-MM-DD.md` under `## Navigation`.
- **up → week** — link `weekly/YYYY-Www.md` (ISO week) under `## Navigation`, even before
  the weekly file exists.

Quiet day → keep `## Topics` and `## Navigation`; `## Cards created today` may be `(none)`.
