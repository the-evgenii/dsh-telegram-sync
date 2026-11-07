import MarkdownIt from 'markdown-it';
import { splitText } from './telegram.mjs';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 20 });
const styles = { strong: 'bold', em: 'italic', s: 'strikethrough', heading: 'bold', th: 'bold' };
const safeUrl = value => {
  try { return ['http:', 'https:', 'tg:', 'mailto:'].includes(new URL(value).protocol); }
  catch { return false; }
};

/** CommonMark/GFM text and UTF-16 Telegram entities; never interpret model output as HTML. */
export function formatMarkdown(source, limit = 4000) {
  let text = '';
  const entities = [], stack = [], lists = [];
  let itemStart = false, cell = 0;
  const append = value => { text += value; };
  const gap = count => {
    if (text) text += '\n'.repeat(Math.max(0, count - (text.match(/\n*$/)?.[0].length ?? 0)));
  };
  const open = (name, type, extra = {}) => stack.push({ name, type, offset: text.length, ...extra });
  const close = name => {
    const index = stack.findLastIndex(item => item.name === name);
    if (index < 0) return;
    const { name: _name, ...entry } = stack.splice(index, 1)[0];
    if (text.length > entry.offset) entities.push({ ...entry, length: text.length - entry.offset });
  };
  const code = (value, type, extra = {}) => {
    if (value) entities.push({ type, offset: text.length, length: value.length, ...extra });
    append(value);
  };
  const walk = tokens => {
    for (const token of tokens) {
      const [name, action] = token.type.split('_');
      if (styles[name] && action === 'open') {
        if (name === 'heading') gap(2);
        if (name === 'th' && cell++ > 0) append(' | ');
        open(name, styles[name]);
      } else if (styles[name] && action === 'close') close(name);
      else switch (token.type) {
        case 'inline': walk(token.children ?? []); itemStart = false; break;
        case 'text': case 'html_inline': case 'html_block': append(token.content); break;
        case 'softbreak': case 'hardbreak': append('\n'); break;
        case 'paragraph_open': if (!itemStart) gap(lists.length ? 1 : 2); break;
        case 'fence': case 'code_block': {
          gap(2);
          const language = token.info.trim().split(/\s+/)[0].slice(0, 64);
          code(token.content, 'pre', language ? { language } : {});
          break;
        }
        case 'code_inline': code(token.content, 'code'); break;
        case 'link_open': open('link', 'text_link', { url: token.attrGet('href') }); break;
        case 'link_close': close('link'); break;
        case 'image': {
          const alt = (token.children ?? []).map(child => child.content).join('') || 'Изображение';
          const url = token.attrGet('src');
          const start = text.length; append(alt);
          if (safeUrl(url)) entities.push({ type: 'text_link', offset: start, length: alt.length, url });
          break;
        }
        case 'bullet_list_open': lists.push({ ordered: false }); break;
        case 'ordered_list_open': lists.push({ ordered: true, next: Number(token.attrGet('start') ?? 1) }); break;
        case 'bullet_list_close': case 'ordered_list_close': lists.pop(); break;
        case 'list_item_open': {
          gap(1);
          const list = lists.at(-1);
          append('  '.repeat(Math.max(0, lists.length - 1)) + (list?.ordered ? `${list.next++}. ` : '• '));
          itemStart = true; break;
        }
        case 'table_open': gap(2); break;
        case 'tr_open': gap(1); cell = 0; break;
        case 'td_open': if (cell++ > 0) append(' | '); break;
        case 'hr': gap(2); append('────────'); break;
      }
    }
  };
  walk(markdown.parse(String(source), {}));

  // Telegram forbids formatting within code/pre, even when CommonMark permits it.
  const opaque = entities.filter(entity => ['code', 'pre'].includes(entity.type));
  const normalized = [], seenEntities = new Set();
  for (const entity of entities) {
    if (entity.type === 'text_link' && !safeUrl(entity.url)) continue;
    let spans = [[entity.offset, entity.offset + entity.length]];
    if (!['code', 'pre'].includes(entity.type)) {
      for (const block of opaque) {
        const start = block.offset, end = start + block.length;
        spans = spans.flatMap(([a, b]) => b <= start || a >= end ? [[a, b]]
          : [[a, Math.min(b, start)], [Math.max(a, end), b]].filter(([x, y]) => x < y));
      }
    }
    for (const [start, end] of spans) {
      const part = { ...entity, offset: start, length: end - start };
      const identity = JSON.stringify([part.type, part.offset, part.length, part.url, part.language]);
      if (!seenEntities.has(identity)) { seenEntities.add(identity); normalized.push(part); }
    }
  }
  normalized.sort((a, b) => a.offset - b.offset || b.length - a.length);

  // Split rendered text, not raw Markdown; clip/rebase entities without splitting emoji.
  const result = [];
  let offset = 0;
  while (offset < text.length) {
    let chunk = splitText(text.slice(offset, offset + limit + 2), limit)[0];
    const overlapping = normalized.filter(e => e.offset < offset + chunk.length && e.offset + e.length > offset);
    if (overlapping.length > 90) chunk = text.slice(offset, overlapping[90].offset);
    if (!chunk) throw new Error('Markdown entity nesting exceeds Telegram limits');
    const end = offset + chunk.length;
    const clipped = normalized.filter(e => e.offset < end && e.offset + e.length > offset).map(entity => {
      const start = Math.max(entity.offset, offset);
      return { ...entity, offset: start - offset, length: Math.min(entity.offset + entity.length, end) - start };
    });
    result.push({ text: chunk, entities: clipped });
    offset = end;
  }
  return result;
}
