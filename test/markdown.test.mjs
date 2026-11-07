import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMarkdown } from '../src/markdown.mjs';

test('nested heading emphasis never duplicates a Telegram entity', () => {
  const [payload] = formatMarkdown('# **bold**');
  assert.equal(payload.text, 'bold');
  assert.deepEqual(payload.entities, [{ type: 'bold', offset: 0, length: 4 }]);
});

test('emoji offsets use UTF-16; HTML stays literal and escaped Markdown stays literal', () => {
  const [payload] = formatMarkdown('😀 **жирный** и _курсив_ & <b>literal</b> \\*literal\\*');
  assert.equal(payload.text, '😀 жирный и курсив & <b>literal</b> *literal*');
  assert.deepEqual(payload.entities, [
    { type: 'bold', offset: 3, length: 6 },
    { type: 'italic', offset: 12, length: 6 },
  ]);
  assert.equal(payload.parse_mode, undefined);
});

test('long fenced code preserves content, language and valid per-chunk entities', () => {
  const content='a'.repeat(3999)+'😀\n**not bold**\n';
  const parts=formatMarkdown('```python\n'+content+'```');
  assert.equal(parts.map(p=>p.text).join(''), content);
  for (const part of parts) {
    assert.ok(part.text.length<=4000);
    assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));
    assert.deepEqual(part.entities,[{type:'pre',offset:0,length:part.text.length,language:'python'}]);
  }
});

test('long bold text clips and rebases formatting without splitting emoji', () => {
  const text='😀'.repeat(2200);
  const parts=formatMarkdown('**'+text+'**');
  assert.equal(parts.map(p=>p.text).join(''),text);
  assert.equal(parts.length,2);
  for(const part of parts) assert.deepEqual(part.entities,[{type:'bold',offset:0,length:part.text.length}]);
});

test('entity-heavy messages split before the Telegram entity budget', () => {
  const parts=formatMarkdown(Array(200).fill('**x**').join(' '));
  assert.equal(parts.map(p=>p.text).join(''),Array(200).fill('x').join(' '));
  assert.ok(parts.length>1);
  for(const part of parts) {
    assert.ok(part.entities.length<=90);
    for(const entity of part.entities) assert.ok(entity.offset>=0 && entity.offset+entity.length<=part.text.length);
  }
});

test('code remains opaque and surrounding emphasis cannot overlap it', () => {
  const [part]=formatMarkdown('**bold `**code**` bold**');
  assert.equal(part.text,'bold **code** bold');
  const code=part.entities.find(e=>e.type==='code');
  assert.equal(part.text.slice(code.offset,code.offset+code.length),'**code**');
  for(const e of part.entities.filter(e=>e.type!=='code')) assert.ok(e.offset+e.length<=code.offset || e.offset>=code.offset+code.length);
});
