import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fencedBlocks, pairedBlocks, stripCodeAnchors, renderCodeChoices, toggleCodeChoice } from './code-block-toggle.mjs';

const original = 'Before\n\n```html\n<div>Hello</div>\n```\n\nBetween\n\n```js\nconsole.log("Welcome");\n```\n\nAfter';
const translated = original.replace('Before', '앞').replace('Between', '사이').replace('After', '뒤')
    .replace('Hello', '안녕').replace('Welcome', '환영');

test('one-block original toggle leaves translated prose and the other block untouched', () => {
    const result = renderCodeChoices(original, translated, [0]);
    assert.equal(result, translated.replace('<div>안녕</div>', '<div>Hello</div>'));
    assert.ok(result.includes('console.log("환영");'));
    assert.equal(renderCodeChoices(original, translated, toggleCodeChoice([0], 0, 2)), translated);
});

test('separate block choices preserve exact source, delimiters, CRLF and indentation', () => {
    const input = 'Start\r\n\r\n  ````html\r\n<p>Hello</p>\r\n```\r\n  ````\r\n\r\n~~~text\r\nWelcome\r\n~~~~\r\nEnd';
    const output = input.replace('Hello', '안녕').replace('Welcome', '환영').replace('Start', '시작').replace('End', '끝');
    assert.equal(fencedBlocks(input).length, 2);
    assert.equal(renderCodeChoices(input, output, [0, 1]), input.replace('Start', '시작').replace('End', '끝'));
    assert.equal(stripCodeAnchors(renderCodeChoices(input, output, [1], true)), renderCodeChoices(input, output, [1]));
});

test('inline backticks are not blocks; nested shorter and different fences are retained in their block', () => {
    assert.equal(fencedBlocks('Inline ```text and `code` here.').length, 0);
    const text = '````text\n```\n~~~\nHello\n````';
    assert.equal(fencedBlocks(text).length, 1);
    assert.equal(fencedBlocks(text)[0].text, text);
});

test('missing or altered fences refuse unsafe block pairing', () => {
    assert.equal(pairedBlocks(original, translated.replace('```js', '```python')).length, 0);
    assert.equal(pairedBlocks(original, translated.slice(0, translated.indexOf('```js'))).length, 0);
    assert.equal(renderCodeChoices(original, 'A summary without code', [0], true), 'A summary without code');
});

test('unfinished fenced blocks are preserved without inserting controls inside their contents', () => {
    const input = '```html\n<div>Hello</div>';
    const output = input.replace('Hello', '안녕');
    assert.equal(fencedBlocks(input)[0].closing, null);
    assert.equal(renderCodeChoices(input, output, [], true), output);
});

function messageHarness() {
    const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    const message = { mes: original, is_user: false, extra: {} };
    const hash = text => createHash('sha256').update(String(text)).digest('hex');
    let saves = 0;
    let updates = 0;
    let apiCalls = 0;
    const context = vm.createContext({
        chat: [message], pairedBlocks, stripCodeAnchors, renderCodeChoices, toggleCodeChoice,
        getSettings: () => ({ translateCodeBlocks: true }), getStringHash: hash,
        updateMessageBlock: () => { updates++; }, decorateMessages() {},
        getContext: () => ({ saveChat: async () => { saves++; } }),
        callTranslator: () => { apiCalls++; }, translateIncoming: () => { apiCalls++; },
    });
    vm.runInContext(source.slice(source.indexOf('function rememberCodeTranslation('), source.indexOf('function isSwipeGenerating(')), context);
    message.extra.display_text = context.rememberCodeTranslation(message, original, translated);
    return { context, message, counts: () => ({ saves, updates, apiCalls }) };
}

test('actual message toggle persists its choice, calls no API, and can restore the translated block', async () => {
    const { context, message, counts } = messageHarness();
    await context.toggleMessageCodeBlock(0, 1);
    assert.equal(stripCodeAnchors(message.extra.display_text), translated.replace('"환영"', '"Welcome"'));
    const restored = JSON.parse(JSON.stringify(message));
    context.chat[0] = restored;
    await context.toggleMessageCodeBlock(0, 1);
    assert.equal(stripCodeAnchors(restored.extra.display_text), translated);
    assert.deepEqual(counts(), { saves: 2, updates: 2, apiCalls: 0 });
});

test('source edits and invalid indices cannot restore a block from stale translation metadata', async () => {
    const { context, message, counts } = messageHarness();
    await context.toggleMessageCodeBlock(0, 99);
    await context.toggleMessageCodeBlock(0, -1);
    message.mes = 'A different swipe';
    await context.toggleMessageCodeBlock(0, 0);
    assert.deepEqual(counts(), { saves: 0, updates: 0, apiCalls: 0 });
});

test('ordinary render preserves choices while explicit full retranslation resets them', async () => {
    const { context, message } = messageHarness();
    await context.toggleMessageCodeBlock(0, 0);
    message.extra.display_text = context.rememberCodeTranslation(message, original, translated);
    assert.equal(stripCodeAnchors(message.extra.display_text), translated.replace('안녕', 'Hello'));
    message.extra.display_text = context.rememberCodeTranslation(message, original, translated, { reset: true });
    assert.equal(stripCodeAnchors(message.extra.display_text), translated);
});

test('a literal anchor example inside actual code is never stripped from the message', () => {
    const literal = '```html\nExample:\n\n<div class="icb_code_start" data-icb-block="0"></div>\n\n```';
    assert.equal(stripCodeAnchors(literal), literal);
    assert.equal(stripCodeAnchors(renderCodeChoices(literal, literal, [], true)), literal);
});
