# Card templates

Frontmatter per type. `type` and `status` MUST exist in
`schema.json` → `node_types`. `description` is a search snippet
(what/why), never a title repeat. `tags`: 2–5, lowercase, kebab-case.
`aliases` (contact, project): the other spellings of the same name — Russian and Latin,
transliteration, the colloquial name, a spelling the owner keeps mistyping. They are a
search column, not a body line: a card titled `Pepsi Gamer` that the owner calls «Пепси»
is found only through `aliases`, and the field merges across updates instead of replacing.

The canonical generic templates live in
`scripts/autograph/docs/references/card-templates.md` — these are the memory-processor-specific
shapes. Nightly cards are written by `write_card`, so its contract wins over any
hand-editing recipe you read there: the `body` you pass is plain facts with
no H1/H2 headings — the tool builds the card's `#` title, its `## Log` and
`## Related`, and `write_card` owns the `## History` section. Pass
a displaced fact through `history_entry` as a single dated line, `YYYY-MM-DD: fact`
(for example `2026-07-31: TDI Group (held 2026-03→06)`), and never write that heading
into `body`. Never pass `history_entry` with ADD, UPDATE, or NOOP.

## note — `cards/notes/<slug>.md`

```yaml
---
type: note
description: >-
  [What this fact/learning is, in one line — used for retrieval]
tags: [topic, subtopic]
status: active
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

## contact — `cards/contacts/<slug>.md`

```yaml
---
type: contact
description: >-
  [Who they are + relationship context]
aliases: [Сайера, Splendor]
tags: [network, role]
status: active
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

## project — `cards/projects/<slug>.md`

```yaml
---
type: project
description: >-
  [What it delivers, for whom]
aliases: [Пепси, Pepsi12]
tags: [area, kind]
status: active
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

## idea — `cards/ideas/<slug>.md`

```yaml
---
type: idea
description: >-
  [The proposal/hypothesis in one line — title as a claim]
tags: [topic]
status: active
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

## decision — `cards/decisions/YYYY-MM-DD-<slug>.md`

```yaml
---
type: decision
description: >-
  [What was decided + the one-line reason]
tags: [area]
status: active
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

Body: what was decided and why, in prose — no `## Decision` / `## Rationale`
headings, `write_card` refuses a body that carries any.

## Anti-patterns

- `description: "Contact"` — useless for search; write a real snippet.
- `status: "interested"` — not in any enum; use what the schema defines.
- `tags: []` — pick 2–5 relevant kebab-case tags.
- `aliases: ["The Same Title"]` — repeating the title adds nothing: keep only the
  spellings the title does not already contain (or drop the field).
- No `## Related` — every card must link (see `linking.md`).
- New card when an existing one covers the subject — update instead.
