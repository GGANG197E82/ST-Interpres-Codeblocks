import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BackgroundJobs } from './server-plugin/jobs.mjs';
import { requestBackend } from './server-plugin/backend.mjs';
import { runBackgroundBatch } from './background-client.mjs';

const spec = (bodies = ['One', 'Two', 'Three', 'Four']) => ({
    payload: { chat_completion_source: 'vertexai', model: 'test', secret_id: 'B' },
    system: 'Translate.', src: 'en', dst: 'ko', retry: true, concurrency: 3,
    tasks: bodies.map(body => ({ body, user: '=== PASSAGE START ===\n' + body + '\n=== PASSAGE END ===' })),
});
const id = 'a'.repeat(64);
const flush = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate()); };

test('server finishes all chunks with zero client polls, retains order and does not resubmit on reconnect', async () => {
    let calls = 0, active = 0, peak = 0;
    const queue = new BackgroundJobs(async payload => {
        calls++; peak = Math.max(peak, ++active);
        await new Promise(resolve => setImmediate(resolve)); active--;
        assert.equal(payload.secret_id, 'B');
        return '번역 ' + payload.messages[1].content;
    }, { limit: 2 });
    const job = queue.submit('alice', id, spec());
    await flush(() => !!job.ended);
    assert.equal(job.status, 'completed'); assert.equal(calls, 4); assert.equal(peak, 2);
    assert.equal(queue.submit('alice', id, spec()), job); assert.equal(calls, 4);
    assert.match(job.results[0], /One/); assert.match(job.results[3], /Four/);
    assert.equal(queue.get('bob', id), undefined);
    assert.throws(() => queue.submit('alice', id, spec(['Different'])), /conflict/);
    queue.close();
});

test('cancellation aborts active requests and prevents queued parts from starting', async () => {
    let calls = 0;
    const queue = new BackgroundJobs((_payload, signal) => new Promise((resolve, reject) => {
        calls++; signal.addEventListener('abort', () => reject(Object.assign(new Error('stop'), { name: 'AbortError' })), { once: true });
    }), { limit: 1 });
    const job = queue.submit('alice', id, spec());
    await flush(() => calls === 1); queue.cancel(job);
    await flush(() => queue.active === 0);
    assert.equal(calls, 1); assert.equal(job.status, 'cancelled'); assert.equal(queue.waiters.length, 0);
    queue.close();
});

test('validation and paragraph fallbacks complete on the server', async () => {
    const body = ['first '.repeat(20), 'second '.repeat(20), 'third '.repeat(20), 'fourth '.repeat(20)].join('\n\n');
    let calls = 0;
    const queue = new BackgroundJobs(async () => ++calls === 1 ? '이것은 잘못된 한 문단의 번역입니다. '.repeat(20) : '정상적인 번역입니다. '.repeat(20));
    const job = queue.submit('alice', id, spec([body]));
    await flush(() => !!job.ended);
    assert.equal(job.status, 'completed'); assert.equal(calls, 5);
    assert.equal(job.results[0].split('\n\n').length, 4);
    queue.close();
});

test('failed or missing seal output is rejected, successful parts remain available', async () => {
    const queue = new BackgroundJobs(async payload => payload.messages[1].content.includes('<seal-1/>') ? '누락됨' : '정상 번역');
    const job = queue.submit('alice', id, spec(['One', 'Two <seal-1/>']));
    await flush(() => !!job.ended);
    assert.equal(job.status, 'failed'); assert.equal(job.results[0], '정상 번역');
    assert.match(job.errors[1], /missing protected tags/);
    queue.close();
});

test('completed results expire and unsupported providers are rejected', async () => {
    const queue = new BackgroundJobs(async () => '번역', { ttl: 1000 });
    assert.throws(() => queue.submit('alice', id, { ...spec(), payload: { chat_completion_source: 'custom', model: 'x' } }), /Invalid/);
    const job = queue.submit('alice', id, spec(['One']));
    await flush(() => !!job.ended); job.ended = Date.now() - 2000;
    assert.equal(queue.get('alice', id), undefined); queue.close();
});

test('backend adapter owns its socket, routes selected key, and aborts independently', async () => {
    const controller = new AbortController(); let socket;
    const router = { handle(req, res) {
        socket = req.socket; assert.equal(req.user.profile.handle, 'alice'); assert.equal(req.body.secret_id, 'B');
        setImmediate(() => res.send({ choices: [{ message: { content: '완료' } }] }));
    } };
    assert.equal(await requestBackend(router, { profile: { handle: 'alice' } }, { secret_id: 'B' }, controller.signal), '완료');
    assert.ok(socket);
    const cancellation = new AbortController(); let stopped = false;
    const waitingRouter = { handle(req) { req.socket.on('close', () => { stopped = true; }); } };
    const pending = requestBackend(waitingRouter, {}, {}, cancellation.signal);
    cancellation.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.ok(stopped);
});

test('client reattaches to the same batch after its submission response is lost', async () => {
    const storageMap = new Map();
    const storage = { getItem: key => storageMap.get(key), setItem: (key, value) => storageMap.set(key, value), removeItem: key => storageMap.delete(key) };
    const queue = new BackgroundJobs(async () => '번역');
    let first = true, posts = [];
    const fetchFn = async (url, options) => {
        const requestId = url.split('/').at(-1);
        if (!options.body) return { ok: true, status: 200, json: async () => queue.view(queue.get('alice', requestId)) };
        posts.push(requestId);
        const job = queue.submit('alice', requestId, JSON.parse(options.body));
        await flush(() => !!job.ended);
        if (first) { first = false; throw new Error('Network disconnected'); }
        return { ok: true, status: 202, json: async () => queue.view(job) };
    };
    await assert.rejects(runBackgroundBatch(spec(['One']), { fetchFn, storage }), /disconnected/);
    assert.deepEqual(await runBackgroundBatch(spec(['One']), { fetchFn, storage }), ['번역']);
    assert.equal(posts.length, 1); assert.equal(queue.jobs.size, 1); queue.close();
});

test('reload reuses an existing server batch even when local checkpoints omit completed tasks', async () => {
    const entries = new Map();
    const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
    const queue = new BackgroundJobs(async payload => '번역 ' + payload.messages[1].content);
    let posts = 0;
    const fetchFn = async (url, options) => {
        const requestId = url.split('/').at(-1);
        if (!options.body) return { ok: true, status: 200, json: async () => queue.view(queue.get('alice', requestId)) };
        posts++;
        const job = queue.submit('alice', requestId, JSON.parse(options.body));
        await flush(() => !!job.ended);
        throw new Error('Browser discarded');
    };
    await assert.rejects(runBackgroundBatch(spec(['One', 'Two']), { fetchFn, storage, scope: 'same-message' }), /discarded/);
    const outputs = await runBackgroundBatch(spec(['Two']), { fetchFn, storage, scope: 'same-message' });
    assert.equal(outputs.length, 1); assert.match(outputs[0], /Two/); assert.equal(posts, 1);
    queue.close();
});

test('server validation uses the same rules as the extension', () => {
    assert.equal(readFileSync(new URL('./translation-validation.mjs', import.meta.url), 'utf8'), readFileSync(new URL('./server-plugin/translation-validation.mjs', import.meta.url), 'utf8'));
});
