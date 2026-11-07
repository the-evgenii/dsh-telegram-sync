export class TelegramError extends Error {
  constructor(code, { uncertain = false, retryAfter = 0 } = {}) {
    super(`Telegram API error ${code}`);
    this.code = code;
    this.uncertain = uncertain;
    this.retryAfter = retryAfter;
  }
}

/** Never include request URLs, tokens, message text or Telegram descriptions in errors. */
export class Telegram {
  constructor({ token, baseUrl = 'https://api.telegram.org', fetchImpl = fetch, maxFileBytes = 20 * 1024 * 1024 }) {
    if (!token) throw new Error('Telegram bot token is required');
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.maxFileBytes = maxFileBytes;
  }
  async call(method, payload = {}, upload = null, signal) {
    let body;
    const headers = {};
    if (upload) {
      body = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      body.set(upload.field, new Blob([upload.bytes], { type: upload.mediaType ?? 'application/octet-stream' }), upload.name);
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(payload);
    }
    let response, value;
    try {
      response = await this.fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST', headers, body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000),
      });
      value = await response.json();
    } catch {
      throw new TelegramError('transport', { uncertain: true });
    }
    if (!value?.ok) {
      if (value?.error_code === 400 && /message is not modified/i.test(value.description ?? '')
        && ['editMessageText', 'editMessageReplyMarkup', 'editForumTopic'].includes(method)) {
        return method === 'editMessageText' ? { message_id: payload.message_id } : true;
      }
      if (value?.error_code === 400 && /TOPIC_ID_INVALID|TOPIC_DELETED|thread not found|topic not found/i.test(value.description ?? '')
        && method === 'deleteForumTopic') return true;
      // 5xx may be an already-committed operation with a lost response.
      throw new TelegramError(value?.error_code ?? response.status, {
        uncertain: response.status >= 500 || value?.error_code >= 500,
        retryAfter: value?.parameters?.retry_after ?? 0,
      });
    }
    return value.result;
  }
  async download(fileId) {
    const file = await this.call('getFile', { file_id: fileId });
    if (!file.file_path || file.file_size > this.maxFileBytes) throw new TelegramError('file-too-large');
    // Telegram supplies this relative path; never follow arbitrary URLs or traversal.
    if (!/^[\w./-]+$/.test(file.file_path) || file.file_path.split('/').includes('..')) throw new TelegramError('file-path');
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/file/bot${this.token}/${file.file_path}`, {
        signal: AbortSignal.timeout(40_000), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > this.maxFileBytes) throw new TelegramError('file-too-large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError('download-failed');
    }
  }
}

/** UTF-16 bounded without splitting surrogate pairs; plain text needs no entity offsets. */
export function splitText(text, limit = 4000) {
  const result = [];
  let chunk = '';
  for (const char of text) {
    if (chunk.length + char.length > limit) { result.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) result.push(chunk);
  return result;
}

export function inboundContent(message) {
  const text = message.text ?? message.caption ?? '';
  const photo = message.photo?.at(-1);
  const media = photo ?? message.document ?? message.voice ?? message.audio ?? message.video ?? message.animation ?? message.video_note ?? message.sticker;
  const files = media ? [{
    fileId: media.file_id,
    name: media.file_name ?? (photo ? 'photo.jpg' : message.voice ? 'voice.ogg' : 'attachment'),
    mediaType: photo ? 'image/jpeg' : media.mime_type ?? 'application/octet-stream',
    image: Boolean(photo) || (Boolean(message.document) && /^image\/(png|jpeg|webp|gif)$/.test(media.mime_type ?? '')),
  }] : [];
  return { text, files };
}
