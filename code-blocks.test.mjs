import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function harness(overrides = {}) {
    const settings = { translateCodeBlocks: true, sealMacros: true, sealTags: '', toneDial: 3, ...overrides };
    const context = vm.createContext({
        getSettings: () => settings,
        getStringHash: value => value,
        bookForChat: () => ({ glossary: [], voiceCards: [] }),
        langName: () => 'Korean', TONE_DIAL_LINES: { 3: 'Balanced rendering.' },
        PROMPT_REV: 2,
        getStore: () => { throw new Error('Legacy store must not be accessed in code-block mode'); },
    });
    vm.runInContext(source.slice(source.indexOf('const SEAL_RX ='), source.indexOf('const TONE_DIAL_LINES =')), context);
    vm.runInContext(source.slice(source.indexOf('function buildUserPrompt('), source.indexOf('const VOICE_SCAN_PROMPT =')), context);
    vm.runInContext(source.slice(source.indexOf('function settingsFingerprint('), source.indexOf('function cacheKey(')), context);
    return { context, settings };
}

test('fenced prose reaches the translator and translated content restores exact fences', () => {
    const { context } = harness();
    const input = 'Before\n\n```text\nHello world\n\nGood morning\n```\n\nAfter';
    const { sealed, vault } = context.sealText(input);
    assert.ok(sealed.includes('Hello world'));
    assert.ok(!sealed.includes('```'));
    const prompt = context.buildUserPrompt(sealed, 'en', 'ko');
    assert.ok(prompt.includes('Hello world'));
    assert.ok(prompt.includes('CODE BLOCK TRANSLATION'));
    const output = sealed.replace('Hello world', '안녕 세상').replace('Good morning', '좋은 아침');
    const result = context.unsealText(output, vault);
    assert.equal(result.restored, input.replace('Hello world', '안녕 세상').replace('Good morning', '좋은 아침'));
    assert.equal(result.missing.length, 0);
});

test('turning the option off keeps whole blocks away from the translator', () => {
    const { context } = harness({ translateCodeBlocks: false });
    const input = '```text\nHello world\n```';
    const { sealed, vault } = context.sealText(input);
    assert.ok(!sealed.includes('Hello world'));
    assert.equal(context.unsealText(sealed, vault).restored, input);
    assert.ok(!context.buildUserPrompt(sealed, 'en', 'ko').includes('CODE BLOCK TRANSLATION'));
});

test('macros, URLs, comments and explicitly excluded tags remain protected inside fences', () => {
    const { context } = harness({ sealTags: 'status' });
    const input = '```html\n<p>Hello world</p>\n{{user}} https://example.com/test\n<!-- private -->\n<status>Do not translate</status>\n```';
    const { sealed, vault } = context.sealText(input);
    assert.ok(sealed.includes('<p>Hello world</p>'));
    for (const protectedText of ['{{user}}', 'https://example.com/test', 'private', 'Do not translate']) {
        assert.ok(!sealed.includes(protectedText));
    }
    assert.equal(context.unsealText(sealed.replace('Hello world', '안녕 세상'), vault).restored,
        input.replace('Hello world', '안녕 세상'));
});

test('multiple, longer, indented and unclosed backtick fences retain their labels and CRLF', () => {
    const { context } = harness();
    const input = '  ````text\r\nHello\r\n  ````\r\n\r\n```html\r\n<p>Hello</p>';
    const { sealed, vault } = context.sealText(input);
    assert.ok(!sealed.includes('````text'));
    assert.equal(context.unsealText(sealed.replaceAll('Hello', '안녕'), vault).restored,
        input.replaceAll('Hello', '안녕'));
});

test('cache modes stay separate and toggling back preserves original cache identity', () => {
    const { context, settings } = harness({ translateCodeBlocks: false });
    assert.equal(context.settingsFingerprint(), 'rev2');
    settings.translateCodeBlocks = true;
    assert.notEqual(context.settingsFingerprint(), 'rev2');
    assert.doesNotThrow(() => context.migrateCacheKeys());
    settings.translateCodeBlocks = false;
    assert.equal(context.settingsFingerprint(), 'rev2');
});

test('a dropped fence marker is detected by existing seal validation', () => {
    const { context } = harness();
    const { sealed, vault } = context.sealText('```text\nHello\n```');
    const result = context.unsealText(sealed.replace('<seal-1/>', ''), vault);
    assert.deepEqual(Array.from(result.missing), [1]);
});
