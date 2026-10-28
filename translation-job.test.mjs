import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { TranslationJob } from './translation-job.mjs';
import { requestReverseProxy } from './reverse-proxy.mjs';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const passage = n => `Hello ${n}: ${'A story sentence. '.repeat(8)}`;
function engine(render) {
    let owner = 'chat-a';
    let store = { blocks: {}, wholes: {}, stats: {} };
    const settings = { translateCodeBlocks: true, structureRetry: false, cacheEnabled: false, splitLongTranslations: true,
        apiMode: 'profile', profileId: 'test', customApi: {}, reverseProxy: {} };
    const calls = [];
    const context = vm.createContext({
        getSettings: () => settings, currentChatId: () => owner,
        getStore: () => store, getStringHash: hash,
        migrateCacheKeys() {}, persistStore() {}, pruneStore() {}, bumpStats() {},
        sealText: text => ({ sealed: text, vault: [] }),
        unsealText: text => ({ restored: text, missing: [] }),
        settingsFingerprint: () => 'test', cacheKey: (text, src, dst, fp) => hash([text, src, dst, fp]),
        blockCacheKey: text => ({ key: hash(text), order: [] }), remapSeals: text => text,
        collectContextLines: () => [], buildSystemPrompt: () => 'translate',
        buildUserPrompt: text => text,
        callTranslator: async (_, text, options) => { calls.push(text); return render(text, options); },
        tidyOutput: text => text.trim(),
        scriptRatio: text => /[가-힣]/.test(text) ? 0.9 : 0,
        langName: () => 'Korean', MODULE_NAME: 'interpres_codeblocks', console,
    });
    vm.runInContext('const SEAL_RX = /<\\s*seal[-_ ]?(\\d+)\\s*\\/?\\s*>/gi;' +
        source.slice(source.indexOf('function splitBlocks('), source.indexOf('/** 직전 턴들의')) +
        source.slice(source.indexOf('async function translateText('), source.indexOf('const inFlight =')), context);
    return { context, calls, settings, get store() { return store; },
        restore: () => { store = JSON.parse(JSON.stringify(store)); },
        switchChat: () => { owner = 'chat-b'; store = { blocks: {}, wholes: {}, stats: {} }; } };
}

test('progress counts success and failure, persists partials, and retry requests only failed chunks', async () => {
    let failing = true;
    const e = engine(async text => {
        if (failing && text.startsWith('Hello 12:')) throw new Error('temporary error');
        return text.replaceAll('Hello', '안녕');
    });
    const text = Array.from({ length: 40 }, (_, n) => passage(n)).join('\n\n');
    const job = new TranslationJob();
    await assert.rejects(e.context.translateText(text, 'en', 'ko', { job }), /temporary error/);
    assert.equal(job.total, 4);
    assert.equal(job.done, 3);
    assert.equal(job.failed, 1);
    assert.equal(e.calls.length, 4);
    assert.equal(Object.values(e.store.partials)[0].signature.includes('undefined'), false);
    e.restore(); // Checkpoints also survive metadata serialization / page reload.
    failing = false;
    const retry = new TranslationJob();
    const result = await e.context.translateText(text, 'en', 'ko', { job: retry, resume: true });
    assert.equal(result, text.replaceAll('Hello', '안녕'));
    assert.equal(e.calls.length, 5);
    assert.ok(e.calls[4].startsWith('Hello 12:'));
    assert.equal(retry.reused, 3);
    assert.equal(retry.done, 4);
});

test('paragraph fallback remembers its route and retry does not repeat the rejected parent request', async () => {
    let failing = true;
    const e = engine(async text => {
        if (failing && text.startsWith('Hello 2:') && !text.includes('\n\n')) throw new Error('paragraph failed');
        return text.replaceAll('Hello', '안녕').replace(/\n{2,}/g, '\n');
    });
    const text = Array.from({ length: 6 }, (_, n) => passage(n)).join('\n\n');
    await assert.rejects(e.context.translateText(text, 'en', 'ko', { job: new TranslationJob() }), /paragraph failed/);
    assert.equal(e.calls.length, 7);
    failing = false;
    const result = await e.context.translateText(text, 'en', 'ko', { job: new TranslationJob(), resume: true });
    assert.equal(result, text.replaceAll('Hello', '안녕'));
    assert.equal(e.calls.length, 8);
    assert.equal(e.calls[7], passage(2).trim());
});

test('cancel stops scheduling, returns before unsupported requests finish, and ignores late outputs', async () => {
    const releases = [];
    const e = engine(text => new Promise(resolve => releases.push(() => resolve(text.replaceAll('Hello', '안녕')))));
    const text = Array.from({ length: 60 }, (_, n) => passage(n)).join('\n\n');
    const job = new TranslationJob();
    const pending = e.context.translateText(text, 'en', 'ko', { job });
    while (e.calls.length < 3) await new Promise(resolve => setImmediate(resolve));
    job.cancel();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(e.calls.length, 3);
    assert.equal(job.status, 'cancelled');
    releases.forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Object.keys(job.cache).length, 0);
    assert.equal(Object.keys(e.store.wholes).length, 0);
    assert.equal(e.calls.length, 3);
});

test('queued cancelled requests never reach the provider and retain slots until active requests settle', async () => {
    const releases = [];
    const e = engine(text => new Promise(resolve => releases.push(() => resolve(text.replaceAll('Hello', '안녕')))));
    const text = Array.from({ length: 40 }, (_, n) => passage(n)).join('\n\n');
    const first = new TranslationJob();
    const second = new TranslationJob();
    const a = e.context.translateText(text, 'en', 'ko', { job: first });
    const b = e.context.translateText(text + ' extra', 'en', 'ko', { job: second });
    while (e.calls.length < 3) await new Promise(resolve => setImmediate(resolve));
    first.cancel(); second.cancel();
    await Promise.all([assert.rejects(a, { name: 'AbortError' }), assert.rejects(b, { name: 'AbortError' })]);
    releases.forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.calls.length, 3);
    assert.equal(await e.context.withTranslationSlot(async () => 'available'), 'available');
});

test('a changed chat cancels late output without writing into either destination', async () => {
    let release;
    const e = engine(text => new Promise(resolve => { release = () => resolve(text.replaceAll('Hello', '안녕')); }));
    let current = true;
    const job = new TranslationJob({ isCurrent: () => current });
    const oldStore = e.store;
    const pending = e.context.translateText(passage(0), 'en', 'ko', { job });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    current = false;
    e.switchChat();
    release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(Object.keys(oldStore.wholes).length, 0);
    assert.equal(Object.keys(e.store.wholes).length, 0);
    assert.equal(Object.keys(job.cache).length, 0);
});

test('full retranslation clears checkpoints; resume of that attempt preserves its new successes', async () => {
    let failing = false;
    const e = engine(text => {
        if (failing && text.startsWith('Hello 12:')) throw new Error('retry me');
        return text.replaceAll('Hello', '안녕');
    });
    const text = Array.from({ length: 25 }, (_, n) => passage(n)).join('\n\n');
    await e.context.translateText(text, 'en', 'ko', { job: new TranslationJob() });
    assert.equal(e.calls.length, 3);
    failing = true;
    await assert.rejects(e.context.translateText(text, 'en', 'ko', { job: new TranslationJob(), fresh: true }), /retry me/);
    assert.equal(e.calls.length, 6);
    failing = false;
    await e.context.translateText(text, 'en', 'ko', { job: new TranslationJob(), fresh: true, resume: true });
    assert.equal(e.calls.length, 7);
});

test('proxy cancellation forwards abort and is not reported as a timeout', async () => {
    const controller = new AbortController();
    let received;
    const fetchFn = async (_, options) => {
        received = options.signal;
        return new Promise((_, reject) => received.addEventListener('abort', () => {
            const error = new Error('cancelled'); error.name = 'AbortError'; reject(error);
        }, { once: true }));
    };
    const pending = requestReverseProxy({ provider: 'openai', url: 'https://example.com/v1', model: 'test' }, '', '', 100, '', {}, fetchFn, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(received.aborted, true);
});

test('cancel preserves already completed parts and provider abort errors remain retryable failures', async () => {
    const job = new TranslationJob();
    await job.part('completed', async () => '보관할 번역');
    let release;
    const pending = job.part('pending', () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    job.cancel();
    await assert.rejects(pending, { name: 'AbortError' });
    release('late result');
    assert.deepEqual(job.cache, { completed: '보관할 번역' });
    const failed = new TranslationJob();
    const timeout = new Error('provider aborted'); timeout.name = 'AbortError';
    failed.finish(timeout);
    assert.equal(failed.status, 'failed');
});

test('changing the source or prompt never reuses checkpoints from another request', async () => {
    const e = engine(text => text.replaceAll('Hello', '안녕'));
    const original = passage(0);
    await e.context.translateText(original, 'en', 'ko', { job: new TranslationJob() });
    await e.context.translateText(original + ' new text', 'en', 'ko', { job: new TranslationJob() });
    e.context.buildSystemPrompt = () => 'new translation style';
    await e.context.translateText(original, 'en', 'ko', { job: new TranslationJob() });
    assert.equal(e.calls.length, 3);
});

test('completed jobs clear recovery checkpoints and respect disabled ordinary caching', async () => {
    const e = engine(text => text.replaceAll('Hello', '안녕'));
    const text = passage(0);
    const job = new TranslationJob();
    await e.context.translateText(text, 'en', 'ko', { job });
    job.finish();
    assert.equal(Object.keys(e.store.partials).length, 0);
    await e.context.translateText(text, 'en', 'ko', { job: new TranslationJob() });
    assert.equal(e.calls.length, 2);
});


test('switching API preserves completed parts and requests only the failed remainder', async () => {
    let fail = true;
    const e = engine(async text => {
        if (fail && text.startsWith('Hello 12:')) throw new Error('provider unavailable');
        return text.replaceAll('Hello', '안녕');
    });
    const text = Array.from({ length: 40 }, (_, n) => passage(n)).join('\n\n');
    await assert.rejects(e.context.translateText(text, 'en', 'ko', { job: new TranslationJob() }), /provider unavailable/);
    assert.equal(e.calls.length, 4);
    e.settings.profileId = 'another-api';
    fail = false;
    const retry = new TranslationJob();
    const out = await e.context.translateText(text, 'en', 'ko', { job: retry, resume: true });
    assert.equal(out, text.replaceAll('Hello', '안녕'));
    assert.equal(e.calls.length, 5);
    assert.equal(retry.reused, 3);
});
