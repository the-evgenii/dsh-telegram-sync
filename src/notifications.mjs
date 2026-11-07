/** Only explicit owner mentions outside code/other links are audible. */
export function mentionsOwner({ text = '', entities = [] }, ownerId, username) {
  for (const entity of entities) {
    if (entity.type !== 'text_link') continue;
    try {
      const url = new URL(entity.url);
      if (url.protocol === 'tg:' && url.hostname === 'user' && url.searchParams.get('id') === String(ownerId)) return true;
    } catch { /* Invalid links cannot mention an owner. */ }
  }
  if (!username || !/^[A-Za-z0-9_]{1,32}$/.test(username)) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@])@${username}(?![\\p{L}\\p{N}_])`, 'giu');
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1].length, end = start + username.length + 1;
    if (!entities.some(e => ['code', 'pre', 'text_link'].includes(e.type) && e.offset < end && e.offset + e.length > start)) return true;
  }
  return false;
}

const terminalMessages = {
  completed: '✅ Задача в Harness завершена.',
  failed: '❌ Задача в Harness завершилась с ошибкой.',
  error: '❌ Задача в Harness завершилась с ошибкой.',
  'max-tokens': '⚠️ Задача в Harness остановлена: достигнут лимит токенов.',
  blocked: '⚠️ Задача в Harness заблокирована: требуется внимание.',
};
export const terminalNotification = reason => Object.hasOwn(terminalMessages, reason) ? terminalMessages[reason] : undefined;
