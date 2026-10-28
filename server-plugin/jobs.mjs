import { createHash } from 'node:crypto';
import { tidyOutput, validateRendering } from './translation-validation.mjs';

const aborted = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const hasText = text => /[\p{L}]/u.test(text.replace(/<seal-\d+\/>/g, ''));
export function validateSpec(spec) {
    if (!spec || !['vertexai', 'makersuite'].includes(spec.payload?.chat_completion_source)
        || typeof spec.payload.model !== 'string' || !spec.payload.model
        || spec.payload.reverse_proxy || !Array.isArray(spec.tasks) || !spec.tasks.length || spec.tasks.length > 120
        || typeof spec.system !== 'string' || !['ko','en','ja','zh','ru','th','fr','de','es','it','pt'].includes(spec.dst)
        || spec.tasks.some(t => typeof t.body !== 'string' || typeof t.user !== 'string' || t.body.length > 100000)
        || JSON.stringify(spec).length > 2000000) throw new Error('Invalid background translation request');
}

// State lives in the server process, independently of the browser connection.
export class BackgroundJobs {
    constructor(run, { limit = 4, ttl = 2 * 60 * 60 * 1000 } = {}) {
        this.run = run; this.limit = limit; this.ttl = ttl;
        this.jobs = new Map(); this.active = 0; this.waiters = [];
    }
    prune() {
        const now = Date.now();
        for (const [id, job] of this.jobs) if (job.ended && now - job.ended > this.ttl) this.jobs.delete(id);
    }
    submit(owner, id, spec) {
        validateSpec(spec); this.prune();
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid job ID');
        const key = owner + ':' + id;
        const digest = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
        const existing = this.jobs.get(key);
        if (existing) {
            if (existing.digest !== digest) throw new Error('Job ID conflict');
            return existing;
        }
        if ([...this.jobs.values()].filter(j => j.owner === owner).length >= 16
            || [...this.jobs.values()].filter(j => !j.ended).length >= 8) throw new Error('Background queue is full');
        const job = { owner, id, digest, controller: new AbortController(), status: 'running',
            results: Array(spec.tasks.length).fill(null), errors: Array(spec.tasks.length).fill(null), total: spec.tasks.length, done: 0 };
        this.jobs.set(key, job);
        this.execute(job, structuredClone(spec)).catch(() => {});
        return job;
    }
    get(owner, id) { this.prune(); return this.jobs.get(owner + ':' + id); }
    view(job) {
        return { id: job.id, status: job.status, done: job.done, total: job.total, results: job.results, errors: job.errors };
    }
    cancel(job) {
        if (job.ended) return;
        job.controller.abort(); job.status = 'cancelled'; job.ended = Date.now();
    }
    async slot(signal, task) {
        if (signal.aborted) throw aborted();
        await new Promise((resolve, reject) => {
            const entry = { signal, resolve: () => { signal.removeEventListener('abort', cancel); resolve(); } };
            const cancel = () => { const i = this.waiters.indexOf(entry); if (i >= 0) this.waiters.splice(i, 1); reject(aborted()); };
            signal.addEventListener('abort', cancel, { once: true });
            this.waiters.push(entry); this.drain();
        });
        try { if (signal.aborted) throw aborted(); return await task(); }
        finally { this.active--; this.drain(); }
    }
    drain() {
        while (this.active < this.limit && this.waiters.length) {
            const entry = this.waiters.shift(); this.active++; entry.resolve();
        }
    }
    async translate(job, spec, task, depth = 0) {
        if (!hasText(task.body)) return task.body;
        const signal = job.controller.signal;
        const check = output => {
            const invalid = validateRendering(output, task.body, spec.src, spec.dst, { structured: !!spec.structured });
            const seals = [...task.body.matchAll(/<seal-\d+\/>/g)].map(m => m[0]);
            return invalid || (seals.some(seal => !output.includes(seal)) ? 'missing protected tags' : null);
        };
        let issue;
        for (let attempt = 0; attempt < (spec.retry ? 2 : 1); attempt++) {
            const user = task.user + (issue ? '\n[OUTPUT CHECK] Preserve every paragraph and protected tag. Return only the complete translation.' : '');
            const payload = { ...spec.payload, stream: false, messages: [{ role: 'system', content: spec.system }, { role: 'user', content: user }, ...(spec.prefill ? [{ role: 'assistant', content: spec.prefill }] : [])] };
            const raw = await this.slot(signal, () => this.run(payload, signal));
            if (signal.aborted) throw aborted();
            const output = tidyOutput(raw, task.body);
            issue = check(output);
            if (!issue) return output;
            if (issue.startsWith('paragraph structure mismatch') && depth === 0) {
                // Reuse the same notes, replacing only the marked passage.
                const start = task.user.lastIndexOf('=== PASSAGE START ===');
                const end = task.user.lastIndexOf('=== PASSAGE END ===');
                if (start < 0 || end < start) break;
                const parts = task.body.split(/(\n{2,})/);
                for (let i = 0; i < parts.length; i += 2) {
                    if (!hasText(parts[i])) continue;
                    const body = parts[i];
                    const userPart = task.user.slice(0, start) + '=== PASSAGE START ===\n' + body + '\n' + task.user.slice(end);
                    parts[i] = await this.translate(job, spec, { body, user: userPart }, 1);
                }
                return parts.join('');
            }
        }
        throw new Error('Translation validation failed: ' + issue);
    }
    async execute(job, spec) {
        let cursor = 0;
        const worker = async () => {
            while (cursor < spec.tasks.length && !job.controller.signal.aborted) {
                const i = cursor++;
                try { job.results[i] = await this.translate(job, spec, spec.tasks[i]); }
                catch (error) { job.errors[i] = error.name === 'AbortError' ? 'Cancelled' : String(error.message); }
                job.done++;
            }
        };
        await Promise.all(Array.from({ length: Math.min(3, Math.max(1, spec.concurrency || 3), spec.tasks.length) }, worker));
        if (!job.controller.signal.aborted) job.status = job.errors.some(Boolean) ? 'failed' : 'completed';
        job.ended = Date.now();
    }
    close() { for (const job of this.jobs.values()) this.cancel(job); this.jobs.clear(); }
}
