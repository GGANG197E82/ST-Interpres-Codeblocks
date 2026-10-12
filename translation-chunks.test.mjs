import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function harness(render = text => text.replaceAll('Hello', '안녕'), overrides = {}) {
    const settings = { translateCodeBlocks: true, structureRetry: true, ...overrides };
    const calls = [];
    const context = vm.createContext({
        getSettings: () => settings,
        buildUserPrompt: text => text,
        callTranslator: async (_, text) => { calls.push(text); return render(text); },
        tidyOutput: text => text.trim(), bumpStats() {},
        scriptRatio: text => /[가-힣]/.test(text) ? 0.9 : 0,
        langName: () => 'Korean', MODULE_NAME: 'interpres_codeblocks', console,
    });
    vm.runInContext('const SEAL_RX = /<\\s*seal[-_ ]?(\\d+)\\s*\\/?\\s*>/gi;' +
        source.slice(source.indexOf('function splitBlocks('), source.indexOf('/** 직전 턴들의')) +
        source.slice(source.indexOf('function validateRendering('), source.indexOf('const inFlight =')), context);
    return { context, calls, settings };
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

test('chunks run concurrently, keep output order, and cap nested fallbacks at three requests', async () => {
    let active = 0;
    let peak = 0;
    const { context } = harness(async text => {
        active++;
        peak = Math.max(peak, active);
        const number = Number(text.match(/Hello (\d+)/)[1]);
        await new Promise(resolve => setTimeout(resolve, number % 3 === 0 ? 12 : 1));
        active--;
        return text.replaceAll('Hello', '안녕').replace(/\n{2,}/g, '\n');
    });
    const text = Array.from({ length: 40 }, (_, n) => `Hello ${n}: ${'A story sentence. '.repeat(8)}`).join('\n\n');
    const results = await Promise.all([
        context.llmTranslate('', text, 'en', 'ko', []),
        context.llmTranslate('', text, 'en', 'ko', []),
    ]);
    assert.equal(peak, 3);
    assert.equal(active, 0);
    for (const result of results) assert.equal(result, text.replaceAll('Hello', '안녕'));
});

test('request slots are released after API rejection and queued work can finish', async () => {
    const { context } = harness();
    const failure = new Error('API failure');
    const tasks = Array.from({ length: 8 }, (_, n) => context.withTranslationSlot(async () => {
        if (n < 3) throw failure;
        return n;
    }));
    const results = await Promise.allSettled(tasks);
    assert.equal(results.filter(result => result.status === 'rejected').length, 3);
    assert.deepEqual(results.slice(3).map(result => result.value), [3, 4, 5, 6, 7]);
    assert.equal(await context.withTranslationSlot(async () => 'ready'), 'ready');
});


test('larger configured chunks reduce requests while retaining all 197 paragraphs', async () => {
    const old = harness();
    const improved = harness(undefined, { chunkChars: 8000, chunkParagraphs: 24 });
    const text = Array.from({ length: 197 }, (_, n) => `Hello ${n}: ${'A story sentence. '.repeat(9)}`).join('\n\n');
    const before = await old.context.llmTranslate('', text, 'en', 'ko', []);
    const after = await improved.context.llmTranslate('', text, 'en', 'ko', []);
    assert.equal(after, before);
    assert.ok(improved.calls.length <= Math.ceil(old.calls.length / 2));
    assert.ok(improved.calls.every(chunk => chunk.length <= 8000 && chunk.split(/\n{2,}/).length <= 24));
    console.log(`197-paragraph fixture: ${old.calls.length} -> ${improved.calls.length} API requests`);
});

test('configured concurrency changes the actual global request limit', async () => {
    for (const limit of [1, 5]) {
        const { context } = harness(undefined, { translationConcurrency: limit });
        let active = 0, peak = 0;
        const results = await Promise.all(Array.from({ length: 15 }, (_, n) => context.withTranslationSlot(async () => {
            active++; peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 1));
            active--; return n;
        })));
        assert.equal(peak, limit); assert.equal(active, 0);
        assert.deepEqual(results, Array.from({ length: 15 }, (_, n) => n));
    }
});

test('lowering concurrency while requests run drains old slots before starting queued work', async () => {
    const { context, settings } = harness();
    const releases = []; const started = [];
    const requests = Array.from({ length: 5 }, (_, n) => context.withTranslationSlot(() => {
        started.push(n); return new Promise(resolve => releases.push(() => resolve(n)));
    }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(started.length, 3);
    settings.translationConcurrency = 1;
    releases.shift()(); releases.shift()();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(started.length, 3);
    releases.shift()();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(started.length, 4);
    releases.shift()();
    await new Promise(resolve => setTimeout(resolve, 0));
    releases.shift()();
    assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3, 4]);
});

test('increasing concurrency can wake queued work without waiting for an active request', async () => {
    const { context, settings } = harness(undefined, { translationConcurrency: 1 });
    const releases = [];
    const requests = Array.from({ length: 3 }, () => context.withTranslationSlot(() => new Promise(resolve => releases.push(resolve))));
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(releases.length, 1);
    settings.translationConcurrency = 3; context.drainTranslationQueue();
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(releases.length, 3);
    releases.forEach(resolve => resolve()); await Promise.all(requests);
});

test('invalid speed values fall back or clamp to bounded integer settings', () => {
    const { context } = harness(undefined, { chunkChars: Infinity, chunkParagraphs: 999, translationConcurrency: 2.9 });
    assert.deepEqual(JSON.parse(JSON.stringify(context.translationSpeedSettings())), { chunkChars: 4000, chunkParagraphs: 60, concurrency: 2 });
});
