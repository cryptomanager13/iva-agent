// The outbound Gate as the scripts side reaches it. The rule about which notices go
// through it - and which static UI strings stay exempt - lives with the seam itself,
// in agent/lib/outbox.ts; here is only the way there. `iva` must load without the
// authored tree (scripts/authored-tree-guard.test.ts), so the import happens inside
// the call that needs it.
//
// Fail-open, like the Gate: with no tree to load - half an update, an installation
// `iva update --force` exists for - the notice still goes out, and the fact that it could not
// be scanned is loud in the log. A silent updater is worse than one unredacted line
// in the owner's own chat.
type Gate = { redactNotice: (text: string) => string };

export async function redactNotice(
  text: string,
  load: () => Promise<Gate> = () => import("../../agent/lib/outbox.ts"),
): Promise<string> {
  try {
    return (await load()).redactNotice(text);
  } catch (error) {
    console.error("[security] outbound gate unavailable for a notice:", error);
    return text;
  }
}

// Everything a Bot API body puts in front of the user sits in these fields: the two
// plain-text ones and, for rich messages, rich_message.markdown just below.
const CHAT_FIELDS = ["text", "caption"] as const;
// Rich-сообщение (Bot API 24.08.2026) несёт тот же текст в rich_message.markdown — экраны
// моста теперь ходят только им, и гейт обязан видеть их так же, как видел text.
type RichMessage = { markdown?: unknown; [key: string]: unknown };

function richMessageBody(value: unknown): RichMessage | null {
  return typeof value === "object" && value !== null
    ? (value as RichMessage)
    : null;
}

// A whole Bot API body through the Gate, so the call to Telegram is where the Gate
// stands and no screen can be written that forgets it. A body with nothing for the chat
// (getUpdates on every poll cycle, deleteMessage, an ack) is handed straight back, as is
// a clean one: the common case costs no copy and no scan.
export async function redactTelegramBody<T>(body: T): Promise<T> {
  if (typeof body !== "object" || body === null) return body;
  const source = body as Record<string, unknown>;
  const gated: Record<string, unknown> = {};
  for (const field of CHAT_FIELDS) {
    const value = source[field];
    if (typeof value !== "string") continue;
    const text = await redactNotice(value);
    if (text !== value) gated[field] = text;
  }
  const rich = richMessageBody(source.rich_message);
  if (typeof rich?.markdown === "string") {
    const markdown = await redactNotice(rich.markdown);
    if (markdown !== rich.markdown) gated.rich_message = { ...rich, markdown };
  }
  // Same body with two known string fields rewritten: the shape it went in with.
  return Object.keys(gated).length === 0
    ? body
    : ({ ...source, ...gated } as T);
}
