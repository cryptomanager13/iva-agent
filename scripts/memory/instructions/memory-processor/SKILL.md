---
name: memory-processor
description: >-
  Iva's daily-memory processor. Reads the day's two-sided transcript
  (daily/YYYY-MM-DD.md), distills noteworthy entities / decisions / ideas
  into typed autograph cards, links them into the graph, and produces a
  daily-summary card (topics + MOC) that navigates down to the raw transcript and
  up to the week. Model-agnostic — runs on any LLM driving the vault (Iva uses
  DeepSeek). Triggered by the daily rollup (scripts/memory/rollup.ts daily).
depends_on: [autograph]
---

# memory-processor — daily transcript → cards + summary

Turn one day of raw conversation into durable, navigable memory.

This skill is **judgment-first**: the model (you) does the classification, tagging,
and linking. The autograph Python scripts are used only for mechanical work
(enforce schema, repair links, generate MOCs, decay, touch). `enrich.py` is **never**
used — you are the enrichment.

## Inputs

- `daily/YYYY-MM-DD.md` — the day's raw two-sided transcript
  (`## HH:MM [text|voice|video|photo|forward from: …]` for the user,
  `## HH:MM [iva]` for Iva's replies; older days may use legacy `[eva]`).
  See `scripts/memory/instructions/rules/daily-format.md`.
- `schema.json` — the vault schema (types, domains, decay).
- Existing cards under `cards/**` and prior summaries under `summaries/`,
  `weekly|monthly|yearly/` — for linking and dedup.

## Outputs

1. Zero or more **entity/decision/idea cards** under `cards/<kind>/`.
2. One **daily-summary card** at `summaries/daily/YYYY-MM-DD.md`.
3. Processing markers appended to the raw daily file (never edit existing entries): one
   part marker after each finished part, the processed marker when the day is done.

## Layout & types (from schema.json)

Paths here are from the vault root, as `read_file`, `grep` and `glob` take them;
the shell code blocks run through `bash` from the project root, so there it is
`grep -rl … vault/cards/` (the memory map's path contract).

| What                              | Folder                           | type            |
| --------------------------------- | -------------------------------- | --------------- |
| Raw transcript (read-only log)    | `daily/YYYY-MM-DD.md`            | — (not a card)  |
| Daily summary                     | `summaries/daily/YYYY-MM-DD.md`  | `daily-summary` |
| Weekly / monthly / yearly summary | `weekly/`, `monthly/`, `yearly/` | `*-summary`     |
| Knowledge note / thought          | `cards/notes/`                   | `note`          |
| Person / org                      | `cards/contacts/`                | `contact`       |
| Project                           | `cards/projects/`                | `project`       |
| Idea / proposal                   | `cards/ideas/`                   | `idea`          |
| Decision                          | `cards/decisions/`               | `decision`      |

Always pick `type` and `status` from `schema.json` → `node_types`. Never invent a status.

## Flow (4 phases)

1. **CAPTURE** (`phases/capture.md`) — read the transcript, segment it, and decide
   what is noteworthy: which entities, decisions, ideas, and topics the day produced.
2. **PROCESS** (`phases/process.md`) — create / update cards for the noteworthy items,
   choosing exactly one `ADD | UPDATE | SUPERSEDE | NOOP` operation, then type +
   description-snippet + tags + status; dedup against existing cards.
3. **LINK** (`phases/link.md`) — wire every new card to its domain hub + 2–3 neighbors.
4. **SUMMARIZE** (`phases/summarize.md`) — write the daily-summary card: the day's
   TOPICS plus a MOC linking up to the week, down to the created cards, and down to
   the raw daily transcript. Then run the mechanical autograph pass.

## Parts: a large day is processed piece by piece

A run has a deadline, and a long day may not fit into one turn. Progress is kept in the
raw file, not in the session, so a cut run is resumed instead of started over.

- Split the transcript into parts at entry boundaries — how big and where to cut is your
  call (by topic or by size). A part always ends after the last entry of its minute.
- For each part: CAPTURE → PROCESS → LINK, then create or extend the daily-summary with the
  part's topics and cards, then append the part marker to the end of the raw file:
  `<!-- processed-through: HH:MM -->`, where `HH:MM` is the heading of the part's last entry.
- The rollup script reads the last part marker and hands you the time it stopped at:
  continue with the first entry after it and extend the existing summary — never redo
  earlier parts.
- After the last part: the processed marker (`phases/summarize.md` §2), then the mechanical
  pass. The day counts as done only with the processed marker; a run that returns a report
  without it leaves the night unfinished.

## Mechanical pass (after writing cards & summary)

Run from the project root (Iva's working directory) — the scripts are part of the repo, not
of the vault, and take the vault directory as an argument (`vault` = `$ASSISTANT_VAULT_DIR`):

```bash
# dry-run first, then --apply
uv run scripts/autograph/cleanup.py vault --apply                         # bounded repair before whole-file readers
uv run scripts/autograph/enforce.py vault vault/schema.json --apply   # schema compliance + autofix
uv run scripts/autograph/graph.py fix vault vault/schema.json --apply # repair broken wiki-links
uv run scripts/autograph/engine.py touch vault/summaries/daily/YYYY-MM-DD.md
uv run scripts/autograph/moc.py generate vault vault/schema.json      # regenerate domain MOCs
uv run scripts/autograph/engine.py decay vault                        # recompute relevance/tiers
uv run scripts/autograph/graph.py health vault vault/schema.json      # confirm score
```

Read `.graph/enforce-report.json` after `enforce.py`. Every path in
`compile_candidates` needs semantic repair during the next rollup pass: reread the
card, decide its current truth, and use `write_card` to leave one coherent card.
The mechanical pass deliberately refuses to guess when duplicate `## Related`
sections contain prose.

If `uv` / Python is unavailable, still produce the cards and summary (they are plain
Markdown) and let the nightly Brain run the mechanical pass later.

## Hard rules

- **Never modify existing transcript entries.** Append only a processing marker (see
  `scripts/memory/instructions/rules/daily-format.md`).
- **No orphans.** Every card created here must link to a hub and ≥2 neighbors before
  you finish (`phases/link.md`).
- **description is a search snippet, not the title.** One line, what/why, ~150 chars.
- **tags:** 2–5, lowercase, kebab-case.
- **Idempotent.** If the daily file already carries a processing marker and a
  `summaries/daily/YYYY-MM-DD.md` exists, only reconcile new entries; do not duplicate cards.
  Entries up to the last part marker are already processed.
- **One structure per card.** Exactly one `## Log` and one `## Related`; never emit
  dated `## Обновление` / `## Update` headings. Pass relations only through the
  `write_card.related` argument, never inside `body`.
- **Verify writes.** Reread every created or updated card before finishing. Confirm
  one Log, one Related, no empty/dated update headings, and that Compiled Truth says
  what is true now. A failed invariant keeps the rollup unfinished.
- **Quiet days are fine.** No noteworthy entities → still write a short daily-summary
  with topics and the MOC down to the raw transcript. Do not manufacture cards.

## References

- `references/classification.md` — what becomes a card vs. stays in the transcript.
- `references/card-templates.md` — frontmatter templates per type.
- `references/linking.md` — hub + neighbor linking protocol.
- `references/daily-summary.md` — the daily-summary card spec (topics + MOC).
- `scripts/autograph/docs/SKILL.md` — the typed vault engine (graph, decay, MOC, dedup).
- `scripts/memory/instructions/rules/{daily,weekly,monthly,yearly}-format.md` — format +
  rollup chain navigation rules.
