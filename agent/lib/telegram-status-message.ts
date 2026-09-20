// Статус-сообщение хода: «Работаю…» с кнопкой [⏹ Стоп] и его уборка в терминале.
// Это UI самого канала, не текст модели, поэтому мимо Outbox.
//
// Статус — rich message (sendRichMessage, Bot API 10.3): кнопка <tg-button> стоит
// прямо в строке текста рядом с «Работаю…», а не клавиатурой под сообщением, поэтому
// и текст, и кнопку несёт одна markdown-строка и правит их один editMessageText.
//
// turn.started шлёт статус и пишет running+sessionId+turnId в run-status.
// Нажатие кнопки (и /stop) ловит Bridge: он берёт sessionId и зовёт cancel-роут
// канала, а terminal-событие приводит статус в порядок: обычный финал удаляет
// сообщение, отмена переписывает его на «Остановлено».
//
// Про eve модуль не знает: канал передаёт хендл Bot API структурно.
import { tr } from "./i18n.ts";
import { readSettings } from "./settings.ts";
import { chatKeyOf, getChatStatus, setChatStatusIf } from "./run-status.ts";
import { isPrivateTelegramChatHandle } from "./telegram-private-chat.ts";

// В callback_data кладём только константу: лимит 64 байта не вмещает sessionId,
// он и так лежит в run-status.
export const TELEGRAM_STOP_CALLBACK = "iva_cancel";

export type TelegramStatusHandle = {
  readonly chatId: string;
  readonly chatType?: string;
  readonly messageThreadId?: number;
  request(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; body: unknown }>;
};

// Функция, а не const: перевод выбирается в момент вызова (правило репо — module-level
// const не должна захватывать tr(), иначе язык замерзает до рестарта).
// Экспорт нужен мосту: сообщение «ход не остановился» переписывается тем же текстом, когда
// подтверждение всё-таки приходит.
export function stoppedText(): string {
  return tr(
    "⏹ Stopped. I'll hold new messages and handle them together with the next one.",
    "⏹ Остановлено. Новые сообщения накоплю и обработаю вместе со следующим.",
  );
}

// Анимированный лоадер статуса — тот же набор, что у /update
// (t.me/addemoji/iconemoji1), печатающие точки, чтобы «Работаю…» визуально
// отличался от обновления. Без Premium у владельца бота Telegram вернёт 400 на
// custom_emoji — тогда анимация выключается навсегда, а текст падает на обычные ⏳.
const WORK_LOADER = {
  alt: "💬",
  customEmojiId: "5818797194127346654",
  fallback: "⏳",
};
let workLoaderSupported = true;
// Рич-путь целиком: старый Bot API не знает sendRichMessage. Один отказ — и статус
// уходит обычным текстом, как до rich; повторять отказ на каждом ходу незачем.
let richStatusSupported = true;

// Строка статуса. Кнопка — inline-элемент rich-разметки, поэтому её место в этой же
// строке; loader падает на ⏳, когда Telegram отверг custom emoji.
function workingMarkdown({
  animated = workLoaderSupported,
  withStop = true,
}: {
  animated?: boolean;
  withStop?: boolean;
} = {}): string {
  const loader = animated
    ? `<tg-emoji emoji-id="${WORK_LOADER.customEmojiId}">${WORK_LOADER.alt}</tg-emoji>`
    : WORK_LOADER.fallback;
  const line = loader;
  // Кнопка — inline-элемент rich-разметки в той же текстовой строке, что и loader.
  // Classic-стиль (см. stopKeyboard / sendClassicWorkingStatus ниже) держит
  // клавиатурный ряд, потому что Bot API reply_markup вообще не живёт внутри текста.
  // 13.09.2026 уходили в row из-за кривой отрисовки inline-кнопок на Android;
  // 22.09.2026 владелец вернул кнопку обратно в строку статуса.
  return withStop
    ? `${line} <tg-button type="callback_data" style="danger" data="${TELEGRAM_STOP_CALLBACK}">⏹</tg-button>`
    : line;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageIdFromResponse(response: { body: unknown }): number | null {
  const body = asRecord(response.body);
  const result = asRecord(body?.result);
  return typeof result?.message_id === "number" ? result.message_id : null;
}

function statusBody(tg: TelegramStatusHandle): Record<string, unknown> {
  return {
    chat_id: tg.chatId,
    disable_notification: true,
    ...(tg.messageThreadId !== undefined
      ? { message_thread_id: tg.messageThreadId }
      : {}),
  };
}

// Кнопку показываем только там, где она сработает: её колбэк принимают лишь в личке
// (scripts/poller/control.ts, ./telegram-stop.ts). В группе мёртвый контрол хуже
// отсутствующего, поэтому кнопка в текст не попадает вовсе. Текстовая /stop в группе
// работает по-прежнему — она через этот путь не ходит.
// Стиль меню владельца (settings.json menuStyle): classic = обычный текст с клавиатурой
// под ним, rich = кнопка в rich message. Читается на каждую отправку.
const classicMenu = () => readSettings().menuStyle !== "rich";

const stopKeyboard = () => ({
  inline_keyboard: [
    [
      {
        text: "⏹",
        callback_data: TELEGRAM_STOP_CALLBACK,
        style: "danger",
      },
    ],
  ],
});

async function sendClassicWorkingStatus(
  tg: TelegramStatusHandle,
  withStop: boolean,
): Promise<number | null> {
  const base = {
    ...statusBody(tg),
    ...(withStop ? { reply_markup: stopKeyboard() } : {}),
  };
  if (workLoaderSupported) {
    const res = await tg.request("sendMessage", {
      ...base,
      text: WORK_LOADER.alt,
      entities: [
        {
          type: "custom_emoji",
          offset: 0,
          length: WORK_LOADER.alt.length,
          custom_emoji_id: WORK_LOADER.customEmojiId,
        },
      ],
    });
    if (res.ok) return messageIdFromResponse(res);
    workLoaderSupported = false;
  }
  const res = await tg.request("sendMessage", {
    ...base,
    text: WORK_LOADER.fallback,
  });
  return res.ok ? messageIdFromResponse(res) : null;
}

export async function sendWorkingStatus(
  tg: TelegramStatusHandle,
  { canStop = true } = {},
): Promise<number | null> {
  const withStop = canStop && isPrivateTelegramChatHandle(tg);
  if (classicMenu()) return sendClassicWorkingStatus(tg, withStop);
  const base = statusBody(tg);
  if (richStatusSupported) {
    const res = await tg.request("sendRichMessage", {
      ...base,
      rich_message: { markdown: workingMarkdown({ withStop }) },
    });
    if (res.ok) return messageIdFromResponse(res);
    // 400 на custom_emoji: кнопка остаётся (она в тексте), а анимация — нет.
    if (workLoaderSupported) {
      workLoaderSupported = false;
      const withoutEmoji = await tg.request("sendRichMessage", {
        ...base,
        rich_message: { markdown: workingMarkdown({ withStop }) },
      });
      if (withoutEmoji.ok) return messageIdFromResponse(withoutEmoji);
    }
    richStatusSupported = false;
    console.error(
      "[telegram] sendRichMessage для статуса отвергнут, шлю обычный текст:",
      JSON.stringify(res.body).slice(0, 300),
    );
  }
  // Статус обязан быть виден даже там, где rich не приняли: без кнопки и анимации,
  // но «Работаю…» в чате есть.
  const fallback = await tg.request("sendMessage", {
    ...base,
    text: workingMarkdown({ animated: false, withStop: false }),
  });
  return fallback.ok ? messageIdFromResponse(fallback) : null;
}

// Ранний статус уходит без кнопки: ход ещё не начался, отменять нечего. Начался — кнопку
// дорисовываем в то же сообщение и по тому же правилу личного чата: кнопка это часть
// текста, поэтому переписывается весь текст, а не клавиатура под ним.
export async function enableWorkingStatusStop(
  tg: TelegramStatusHandle,
  messageId: number,
): Promise<void> {
  if (!isPrivateTelegramChatHandle(tg)) return;
  if (classicMenu()) {
    await tg.request("editMessageReplyMarkup", {
      chat_id: tg.chatId,
      message_id: messageId,
      reply_markup: stopKeyboard(),
    });
    return;
  }
  if (!richStatusSupported) return;
  await tg.request("editMessageText", {
    chat_id: tg.chatId,
    message_id: messageId,
    rich_message: { markdown: workingMarkdown({ withStop: true }) },
  });
}

// Терминал хода: state → idle (+wasCancelled), статус-сообщение удалить (обычный финал)
// или переписать на «Остановлено» (отмена). Сбои уборки не критичны — глотаем.
export async function finishTelegramStatus(
  channel: {
    telegram: TelegramStatusHandle;
  },
  sessionId: string,
  mode: "completed" | "cancelled" | "failed",
): Promise<boolean> {
  const tg = channel.telegram;
  const key = chatKeyOf(tg.chatId, tg.messageThreadId);
  const st = getChatStatus(key);
  // Compare and update happen under one per-chat lock. A reset can remove
  // sessionId after this read; a late terminal event then becomes a no-op.
  const casOk = setChatStatusIf(
    key,
    { sessionId },
    {
      status: "idle",
      sessionId: null,
      turnId: null,
      statusMessageId: null,
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      latencyLogged: null,
      ...(mode === "cancelled" ? { wasCancelled: true } : {}),
    },
  );
  // Only touch Telegram when the pre-CAS snapshot was OUR session. A late
  // terminal event from an old finished session must not delete another
  // live session's Working… message in the same chat.
  if (st?.sessionId === sessionId) {
    const msgId = st.statusMessageId;
    if (typeof msgId === "number") {
      try {
        if (mode === "cancelled") {
          await tg.request("editMessageText", {
            chat_id: tg.chatId,
            message_id: msgId,
            rich_message: { markdown: stoppedText() },
          });
        } else {
          await tg.request("deleteMessage", {
            chat_id: tg.chatId,
            message_id: msgId,
          });
        }
      } catch {
        /* статус-сообщение не убралось — не критично */
      }
    }
  }
  return Boolean(casOk);
}
