import { EventEmitter } from 'node:events';

/** Invoke ST's existing provider adapter with a socket owned by the job. */
export function requestBackend(router, user, payload, signal, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        const socket = new EventEmitter();
        let finished = false;
        let disconnected = false;
        const finish = (error, value) => {
            if (finished) return;
            finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
            error ? reject(error) : resolve(value);
        };
        const cancel = () => { disconnected = true; socket.emit('close'); finish(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); };
        // JWT acquisition may complete after cancellation and attach its listener late.
        socket.on('newListener', event => { if (event === 'close' && (signal.aborted || disconnected)) queueMicrotask(() => socket.emit('close')); });
        const timer = setTimeout(() => { disconnected = true; socket.emit('close'); finish(new Error('Provider response timed out')); }, timeoutMs);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) { cancel(); return; }
        const request = { method: 'POST', url: '/generate', originalUrl: '/generate', body: payload, user, headers: {}, socket, connection: socket };
        const response = {
            statusCode: 200, headersSent: false, locals: {},
            status(code) { this.statusCode = code; return this; },
            setHeader() {}, getHeader() { return undefined; },
            send(data) {
                this.headersSent = true;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* handled below */ } }
                if (this.statusCode >= 400 || data?.error) { finish(new Error('Provider request failed (HTTP ' + this.statusCode + '). Check the SillyTavern server log.')); return this; }
                const content = data?.choices?.[0]?.message?.content;
                if (typeof content !== 'string' || !content.trim()) finish(new Error('Provider returned no translation'));
                else finish(null, content);
                return this;
            },
            json(data) { return this.send(data); }, end() { finish(new Error('Provider returned no translation')); },
        };
        try { router.handle(request, response, error => finish(error || new Error('Provider route unavailable'))); }
        catch (error) { finish(error); }
    });
}
