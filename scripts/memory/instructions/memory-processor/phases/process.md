# Phase 2: PROCESS

Turn the CAPTURE plan into card files. Create new cards or update existing ones.

## Input

- The `items` list from Phase 1.
- Existing cards under `cards/**` (and summaries) for dedup.

## Steps

For each item:

1. **Dedup first.** Search for an existing card before creating one:
   ```bash
   grep -ril "<entity name or key phrase>" vault/cards/
   ```
   Then choose exactly one operation and pass it to `write_card`:
   - No match → **ADD**. Create the card; ADD refuses an existing identity.
   - Match, same fact already present → **NOOP**. Do not touch the file.
   - Match, genuinely new and compatible fact → **UPDATE**. The tool appends one
     dated bullet under the card's single `## Log`.
   - Match, new fact contradicts current truth → **SUPERSEDE**. Pass the complete
     new Compiled Truth in `body` and the displaced old fact in `history_entry`
     as a single dated line, `YYYY-MM-DD: fact` (the fact's own date, not today's).
     The tool rewrites current truth and keeps one append-only History:
     `write_card` owns the `## History` section, so never write that heading
     into `body` yourself.
     Never pass `history_entry` with ADD, UPDATE, or NOOP.
     See `references/classification.md` → "ADD / UPDATE / SUPERSEDE / NOOP".
     Never use `UPDATE` to hide a contradiction in chronology.
   - Tag each written card with `confidence: EXTRACTED|INFERRED` (see
     classification.md → "Confidence").
2. **Path & filename.** Place by type (see SKILL layout table). Filenames are
   kebab-case slugs:
   - `cards/contacts/jane-doe.md`, `cards/projects/iva-memory.md`,
     `cards/ideas/layered-memory-with-decay.md`,
     `cards/decisions/2026-06-20-systemd-timers.md`,
     `cards/notes/deepgram-nova3-multi.md`
   - Decisions and dated notes may prefix the date for ordering.
3. **Frontmatter.** Use the template for the type (`references/card-templates.md`).
   - `type` and `status` MUST come from `schema.json` → `node_types`.
   - `description` is a search snippet (what/why), never a title repeat.
   - `tags`: 2–5, lowercase, kebab-case.
   - `created: YYYY-MM-DD` and `source: daily/YYYY-MM-DD.md`.
4. **Body.** A few sentences of context — facts only, with no H1/H2 headings; a
   `body` carrying one is refused. `write_card` builds the card's structure itself:
   the `#` title, the dated `## Log`, `## Related`, and the append-only `## History`.
   Collect relation targets and pass them through the `related` argument. Quote the
   transcript only as needed; link back with `source: daily/YYYY-MM-DD.md` in
   frontmatter.
5. **Reread.** After each non-NOOP call, reread the returned file. Confirm current
   truth is current, and that it contains at most one `## Log`, at most one
   `## Related`, and no dated `## Обновление` / `## Update` heading.

## Title-as-claim (for notes & ideas)

Prefer specific claims over topic labels, so links read naturally:

- weak: `Agent Memory` → strong: `Agents need layered memory that decays when unused`
- Test: "Because of [[title]], …" should read as a sentence.

## Output of this phase

A list of created/updated card paths, carried into Phase 3 (LINK):

```
created: [cards/decisions/2026-06-20-systemd-timers.md, ...]
updated: [cards/projects/iva-memory.md, ...]
```

Do not finish here — unlinked cards are orphans. Continue to LINK.
