/** A resumable translation owns its cancellation and successful-part checkpoints. */
export function cancellationError() {
    const error = new Error('번역을 취소했습니다.');
    error.name = 'AbortError';
    return error;
}

export class TranslationJob {
    constructor({ onChange = () => {}, isCurrent = () => true } = {}) {
        this.controller = new AbortController();
        this.onChange = onChange;
        this.isCurrent = isCurrent;
        this.cache = {};
        this.fallbacks = {};
        this.save = () => {};
        this.cleanups = [];
        this.status = 'running';
        this.started = Date.now();
        this.total = 0;
        this.done = 0;
        this.failed = 0;
        this.reused = 0;
    }
    get signal() { return this.controller.signal; }
    get elapsed() { return Math.floor(((this.ended || Date.now()) - this.started) / 1000); }
    check() {
        if (!this.isCurrent() && !this.signal.aborted) this.cancel();
        if (this.signal.aborted) throw cancellationError();
    }
    cancel() {
        if (this.status !== 'running') return;
        this.status = 'cancelled';
        this.ended = Date.now();
        this.controller.abort();
        this.onChange(this);
    }
    plan(total) {
        this.total = total;
        this.done = this.failed = 0;
        this.onChange(this);
    }
    settled(error) {
        if (this.signal.aborted) return;
        if (error) this.failed++;
        else this.done++;
        this.onChange(this);
    }
    finish(error) {
        this.ended = Date.now();
        this.status = this.signal.aborted
            ? 'cancelled' : error ? 'failed' : 'completed';
        if (this.status === 'completed') for (const cleanup of this.cleanups) cleanup();
        this.onChange(this);
    }
    async part(key, task) {
        this.check();
        if (Object.hasOwn(this.cache, key)) {
            this.reused++;
            this.onChange(this);
            return this.cache[key];
        }
        // The provider may not support abort. Stop waiting and discard its late result;
        // its API slot remains occupied until the underlying request actually settles.
        let onAbort;
        const aborted = new Promise((_, reject) => {
            onAbort = () => reject(cancellationError());
            this.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            const result = await Promise.race([Promise.resolve().then(() => {
                this.check();
                return task();
            }), aborted]);
            this.check();
            this.cache[key] = result;
            this.save();
            return result;
        } finally {
            this.signal.removeEventListener('abort', onAbort);
        }
    }
}
