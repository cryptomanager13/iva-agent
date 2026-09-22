const SILENT_MARKER = /^<!-- iva:silent -->(?:\r?\n|$)/u;

/** Extract the delivery choice from a model reply before it reaches the Outbox. */
export function parseTelegramDelivery(message: string): {
  text: string;
  silent: boolean;
} {
  const marker = SILENT_MARKER.exec(message)?.[0];
  return marker
    ? { text: message.slice(marker.length), silent: true }
    : { text: message, silent: false };
}
