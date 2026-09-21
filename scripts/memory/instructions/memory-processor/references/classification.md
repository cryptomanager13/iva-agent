# Classification — what becomes a card

Decide per noteworthy item. When unsure, prefer **fewer, richer** cards over many thin
ones. Most transcript lines stay in the transcript and never become cards.

## Map content → type

| Signal in the transcript                                              | type       | folder             |
| --------------------------------------------------------------------- | ---------- | ------------------ |
| A person/org that will recur ("met X", "from company Y")              | `contact`  | `cards/contacts/`  |
| Ongoing effort with deliverables ("working on Z", "the X project")    | `project`  | `cards/projects/`  |
| A choice made + reason ("decided to…", "going with… because…")        | `decision` | `cards/decisions/` |
| A proposal/hypothesis worth revisiting ("what if…", "idea:")          | `idea`     | `cards/ideas/`     |
| A durable fact / learning / reference ("turns out…", "TIL", a how-to) | `note`     | `cards/notes/`     |

## Stays in the transcript (do NOT card)

- Logistics, scheduling, acknowledgements, transient status.
- One-off questions already answered inline by Iva with no lasting fact.
- Emotional venting with no decision/idea/fact to keep.
- Anything already represented by an existing card → **update** that card instead.

## Topics (for the daily-summary)

Topics are 2–6 short labels describing what the day was _about_ — broader than tags,
narrower than domains. Examples: `iva-memory`, `deepgram`, `vault-schema`, `family`,
`reading`. They populate the summary's `## Topics` and `topics:` frontmatter and are the
primary way weekly/monthly/yearly rollups understand the period.

## Decision vs. idea vs. note

- **decision** — irreversible-ish, has a rationale, can later be `superseded`/`reverted`.
- **idea** — not yet acted on; status `active` → `explored` → `archived`.
- **note** — a fact/learning with no action attached.

## Update vs. create

Update an existing card when the new info is the _same subject_. Signs you should update:
same person, same project, same decision being refined. Append a dated line under a
`## Log` section and pass the card's `description` back **verbatim**. The `description` is
half of the Compiled Truth and an UPDATE never rewrites it: a "sharper" wording of the same
fact is not new information, and a changed fact is a SUPERSEDE with `history_entry`, not a
quiet rewrite of the description. Creating a near-duplicate is the most common mistake —
grep first.

## ADD / UPDATE / SUPERSEDE / NOOP (temporal conflict)

For every fact, pick one operation:

- **ADD** — genuinely new subject → create a card (prefer the `write_card` tool; it enforces
  the schema so you can't invent a type or field).
- **UPDATE** — existing subject, new fact compatible with current truth → add it to
  the card's single dated `## Log` and repeat the card's `description` verbatim (the tool
  refuses nothing here, but a rewritten description is a change of fact: see SUPERSEDE).
  UPDATE never creates a card and never carries a contradictory former/superseded pair.
- **NOOP** — already captured and unchanged → do nothing.
- **SUPERSEDE** — the new fact _contradicts_ the Compiled Truth of an existing card (job changed,
  moved city, status flipped). Do NOT just append: **rewrite** the card's Compiled Truth
  (frontmatter field + top of the description) to the new fact — Compiled Truth is the
  living snapshot of what is true _now_ — and pass the OLD value to `write_card` through
  `history_entry` as a single dated line, `YYYY-MM-DD: fact` (for example
  `2026-07-31: TDI Group (held 2026-03→06)`), dated by the fact itself, not by today.
  `write_card` owns the `## History` section: never write that heading into `body` yourself.
  Never pass `history_entry` with ADD, UPDATE, or NOOP. History is append-only and never edited.
  **Never leave two contradictory Compiled Truths on the same subject.**
  If a whole card is obsolete (project renamed, decision reverted), say it in the card's
  new `## Log` fact, set `status: superseded` where the type's schema allows it, and point
  at the replacement through `related` (`[[new-card]]`) — `write_card` has no
  `superseded_by` field, so asking for it writes nothing.

Whatever the operation, the `body` you pass is facts only, with no H1/H2 headings —
`write_card` builds the card's structure (the `#` title, `## Log`, `## Related`,
`## History`) and refuses a body that carries a heading of its own.

The deterministic scan `.graph/supersede-candidates.json` lists same-entity cards with
conflicting fields — resolve each by superseding the stale one.

The mechanical report `.graph/enforce-report.json` may list `compile_candidates`
whose duplicate Related sections contain prose. Reread and repair those cards
semantically on the next rollup pass; deterministic cleanup will not discard prose.

## Confidence

Tag each fact's certainty in frontmatter with `confidence:`:

- **EXTRACTED** — the user stated it directly (assert it when recalling).
- **INFERRED** — you deduced it (hedge when recalling: "похоже, ты…").
- **AMBIGUOUS** — unclear/conflicting source (flag it).
