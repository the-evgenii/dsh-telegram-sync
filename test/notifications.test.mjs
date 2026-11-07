import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsOwner, terminalNotification } from '../src/notifications.mjs';
import { formatMarkdown } from '../src/markdown.mjs';

test('mentions match only the owner and exclude code, links, emails and username prefixes', () => {
  const has=source=>formatMarkdown(source).some(payload=>mentionsOwner(payload,42,'owner_test'));
  assert.equal(has('😀 @OWNER_TEST, привет'),true);
  assert.equal(has('[@owner_test](tg://user?id=42)'),true);
  for(const text of ['@someone_else','@owner_test_extra','foo@owner_test','`@owner_test`','```\n@owner_test\n```',
    '[@owner_test](https://example.com)','[чужой](tg://user?id=43)']) assert.equal(has(text),false,text);
  assert.equal(terminalNotification('constructor'),undefined);
  assert.equal(terminalNotification('cancelled'),undefined);
});
