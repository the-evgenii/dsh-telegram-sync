import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('native plugin metadata resolves Telegram Sync title without changing package or settings identity', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'dsh-telegram-sync');
  assert.ok(manifest.files.includes('locale'));
  for (const language of ['en', 'ru']) {
    const path = import.meta.resolve(`dsh-telegram-sync/locale/${language}.json`);
    const locale = JSON.parse(readFileSync(new URL(path), 'utf8'));
    assert.equal(locale.meta.title, 'Telegram Sync');
    assert.ok(locale.meta.description.length > 0);
  }
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: telegram-conversation-sync/);
});
