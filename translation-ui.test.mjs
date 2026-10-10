import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TranslationJob } from './translation-job.mjs';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function buttons(jobs, chat = [], translateIncoming = () => {}) {
    const handlers = new Map();
    const document = {};
    const $ = target => ({
        on(event, selector, handler) {
            handlers.set(target === document ? selector : target, handler || selector);
            return this;
        },
        closest() { return { attr: name => target[name] }; },
    });
    const context = vm.createContext({ $, document, translationJobs: jobs, chat, translateIncoming });
    for (const name of ['importCarry', 'dropCarry', 'downloadBook', 'chooseBookFile', 'scanGlossary', 'scanVoiceCards',
        'translateWholeChat', 'clearAllTranslations', 'clearCache', 'cancelBatchTranslation']) context[name] = () => {};
    vm.runInContext(source.slice(source.indexOf('function bindUI()'), source.indexOf('function registerCommands()')), context);
    context.bindUI();
    return handlers;
}

test('message cancel button cancels only its own translation', () => {
    const first = new TranslationJob();
    const second = new TranslationJob();
    const handlers = buttons(new Map([['in:0', first], ['in:1', second]]));
    handlers.get('.icb_cancel_job').call({ 'data-job-key': 'in:0' });
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, false);
});

test('resume button invokes the failed job and cannot duplicate a running or stale translation', () => {
    let retries = 0;
    let current = true;
    const job = new TranslationJob({ isCurrent: () => current });
    job.retry = () => { retries++; };
    const handlers = buttons(new Map([['in:0', job]]));
    const click = () => handlers.get('.icb_retry_job').call({ 'data-job-key': 'in:0' });
    click();
    assert.equal(retries, 0);
    job.finish(new Error('failed'));
    click();
    assert.equal(retries, 1);
    current = false;
    click();
    assert.equal(retries, 1);
});

test('full retranslation keeps the old displayed translation until the replacement succeeds', async () => {
    const message = { mes: 'Original', extra: { display_text: '기존 번역' } };
    let called;
    const handlers = buttons(new Map(), [message], async (id, options) => { called = { id, ...options }; });
    await handlers.get('.icb_redo_btn').call({ mesid: '0' });
    assert.deepEqual(called, { id: 0, force: true, fresh: true });
    assert.equal(message.extra.display_text, '기존 번역');
});
