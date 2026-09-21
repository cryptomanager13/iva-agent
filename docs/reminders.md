# Reminders

Ask Iva to remind you, and she will — at the right minute, in your timezone, in your chat. A reminder is not a note she might recall later: it is a row in `data/`, picked up by a dispatcher that wakes every minute. Restart the server, update Iva, roll the version back — the row is still there, and anything that came due while the machine was down fires on the first tick after it comes back.

## How to ask

Plain words in the chat, the way you would tell a person:

- «remind me in 30 minutes to call the clinic»
- «remind me at 14:30 to send the invoice»
- «on 14 September at 09:00 — the contract deadline»
- «every weekday at 09:00 remind me about standup»
- «what reminders do I have?» — she lists them
- «cancel the standup one» — she finds it and removes it

Two kinds: a one-time reminder fires once and is done, a repeating one takes its next time from the calendar and waits for it. You never write the date arithmetic yourself and neither does she: you say when, Iva turns it into an exact moment and tells you back the time she stored.

| You say                                              | What it means                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `in 30m`, `in 1h 30m`, `in 2d`                       | a delay from now                                                   |
| `14:30`                                              | today at that wall-clock time; if it has already passed — tomorrow |
| `2026-09-14 09:00`                                   | that date and time on your wall clock                              |
| an ISO instant with an offset or `Z`                 | exactly that moment, wherever you are                              |
| a five-field schedule expression, e.g. `0 9 * * 1-5` | repeating: 09:00 on weekdays, in your timezone                     |

Everything is read in your timezone — the one Iva is configured with, not the server's. A date that does not exist on your clock (the hour skipped by a daylight-saving change, 31 February) is refused with that reason instead of being rounded to something nearby. So is a time in the past, and anything more than a year out.

## What happens at the time

Your reminder text is an instruction Iva gives her future self. At the due minute she wakes in a fresh session that knows nothing about the conversation you asked in, does what the text says — with her tools, so «find the news and send it» really goes and finds them — and the code sends the final text of that turn back to the chat and topic where you asked. One turn, one message.

That is why the text is written to stand on its own: «remind me about the standup» and «collect yesterday's tasks and list what is still open» both work, but «do that thing we discussed» will not — by then the discussion is gone.

If the turn cannot run at all (the model provider is down, the agent breaks, the answer comes back empty), the code sends your text back to you exactly as you dictated it, and the row says what broke. So a reminder always arrives, with or without the model.

Nothing repeats. A row fires once: the moment it fires it is marked, and a repeating row moves on to its next time. There is no retry ladder, no window that removes a reminder hours later, and no warning per failure — the fact of the firing stays with the row: `fired_at`, `delivered` and the reason in `error`.

## Where to see the list

`/menu` → **⏰** shows the nearest reminders, what failed to go out, and one line about the dispatcher: when it last ticked (its pulse is the file `data/reminders.tick`, touched every minute). A fresh pulse means the machinery is alive; a stale one, or none at all, is your signal that reminders are stored but nothing will fire until Iva is running again.

You can also just ask in the chat: she lists the same rows with their ids, the next time, and the last firing with the delivery fact. Rows stay in the list for a day after they fire — that is where you see whether the text went out. Ask her to cancel one and she removes it by id.

## When something breaks

- **Nothing arrived.** The row shows `delivered: false` and the reason in `error`. Fix the chat settings or the token, then ask again — a one-time reminder has already fired, so put a new one.
- **The agent turn could not run.** Your text still arrives, verbatim; the reason is in `error` and in the journal (`journalctl --user -u iva.service | grep reminders`).
- **The dispatcher is not ticking.** The list warns that the reminder is stored but will not fire, and `iva doctor` says the same by the pulse file. It also lists every reminder that fired in the last day and did not go out.

## What Iva no longer does

She used to be able to build her own timer: a transient system unit, a `crontab` line, a `sleep` loop with a `curl` to the Telegram API, a small script of her own. All of that is now refused before it runs, and the refusal names the reminder tool as the replacement. Home-made timers failed in exactly three ways: they did not survive a reboot, they required converting your local time to the server's by hand and got it wrong by hours, and they were invisible — nothing listed them and a silent failure looked identical to success. Reading is untouched: Iva can still inspect `crontab -l`, service status and the journal.

## Limits

- **Back to where you asked.** A reminder returns to the chat and forum topic it was created in; another person as the recipient is not supported. Reminders created before 0.4.4 go to the owner chat from the settings.
- **No more often than every ten minutes.** A repeating schedule tighter than that is refused: that is a monitoring job, not a reminder.
- **Your timezone, one of them.** Everything is computed in the timezone Iva is configured with.
- **A reminder is one turn, not a project.** It fires, Iva does what the text says in that single turn and answers once (or, if repeating, moves to the next occurrence). The turn has no time limit: it runs as long as the work needs, and only two things end it — `/stop` sent from the same chat, or three minutes of silence from the model. The turn posts no “Working…” message, so it grows no ⏹ button of its own in that chat: `/stop` is the way to end it. She sets no new reminders in it: that turn may list and remove them, not add.
