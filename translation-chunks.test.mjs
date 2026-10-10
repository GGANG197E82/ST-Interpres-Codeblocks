import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function harness(render = text => text.replaceAll('Hello', '안녕')) {
    const calls = [];
    const context = vm.createContext({
        getSettings: () => ({ translateCodeBlocks: true, structureRetry: true }),
        buildUserPrompt: text => text,
        callTranslator: async (_, text) => { calls.push(text); return render(text); },
        tidyOutput: text => text.trim(), bumpStats() {},
        scriptRatio: text => /[가-힣]/.test(text) ? 0.9 : 0,
        langName: () => 'Korean', MODULE_NAME: 'interpres_codeblocks', console,
    });
    vm.runInContext('const SEAL_RX = /<\\s*seal[-_ ]?(\\d+)\\s*\\/?\\s*>/gi;' +
        source.slice(source.indexOf('function splitBlocks('), source.indexOf('/** 직전 턴들의')) +
        source.slice(source.indexOf('function validateRendering('), source.indexOf('const inFlight =')), context);
    return { context, calls };
}

test('197 paragraphs translate in bounded requests without losing separators or content', async () => {
    const { context, calls } = harness();
    const text = Array.from({ length: 197 }, (_, n) => `Hello ${n}: ${'A story sentence. '.repeat(9)}`).join('\n\n');
    const result = await context.llmTranslate('', text, 'en', 'ko', []);
    assert.equal(result, text.replaceAll('Hello', '안녕'));
    assert.ok(calls.length > 1);
    assert.ok(calls.every(chunk => chunk.length <= 4000));
    assert.ok(calls.every(chunk => chunk.split(/\n{2,}/).length <= 12));
});

test('models collapsing paragraph whitespace fall back to individual paragraphs', async () => {
    const { context, calls } = harness(text => text.replaceAll('Hello', '안녕').replace(/\n{2,}/g, '\n'));
    const text = Array.from({ length: 6 }, (_, n) => `Hello ${n}: ${'A story sentence. '.repeat(8)}`).join('\n\n');
    const result = await context.llmTranslate('', text, 'en', 'ko', []);
    assert.equal(result, text.replaceAll('Hello', '안녕'));
    assert.equal(calls.length, 7);
});

test('mostly markup code is not rejected for a low target-language ratio or whitespace changes', async () => {
    const { context } = harness(text => text.replaceAll('Hello', '안녕').replace(/\n{2,}/g, '\n'));
    const text = '<seal-0/>\n' + Array.from({ length: 8 }, () => '<div class="panel" data-state="idle">Hello</div>').join('\n\n') + '\n<seal-1/>';
    context.scriptRatio = () => 0;
    const result = await context.llmTranslate('', text, 'en', 'ko', ['```html', '```']);
    assert.ok(result.includes('안녕'));
    assert.ok(result.startsWith('<seal-0/>'));
    assert.ok(result.endsWith('<seal-1/>'));
});

test('empty and severely truncated structured translations still fail validation', () => {
    const { context } = harness();
    const text = '<div>' + 'Long original contents. '.repeat(80) + '</div>';
    assert.equal(context.validateRendering('', text, 'en', 'ko', { structured: true }), 'empty reply');
    assert.equal(context.validateRendering('안녕', text, 'en', 'ko', { structured: true }), 'reply is far shorter than the passage');
});

test('single-spaced long code is split on line boundaries and seals remain atomic', () => {
    const { context } = harness();
    const text = '<seal-0/>\n' + ('<p>Hello</p>\n'.repeat(900)) + '<seal-1/>';
    const chunks = Array.from(context.splitTranslationChunks(text));
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every(chunk => chunk.length <= 4000));
    assert.equal(chunks[0].slice(0, 9), '<seal-0/>');
    assert.ok(chunks.at(-1).endsWith('<seal-1/>'));
});
