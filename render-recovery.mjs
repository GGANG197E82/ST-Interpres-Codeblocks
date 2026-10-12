// Tavern Helper render recovery. Invoke only its renderer callback: never
// broadcast message events, change translator settings, or touch chat contents.
export function isFrontendText(text) {
    return /(?:html>|<head\s*>|<body(?:\s|>))/i.test(String(text));
}

export function rendererListeners(context, event) {
    const listeners = context.eventSource?.events?.[event];
    if (!Array.isArray(listeners)) return [];
    return listeners.filter(fn => {
        if (typeof fn !== 'function') return false;
        const source = Function.prototype.toString.call(fn);
        // Verified against TH's message_iframe_runtimes store, including its
        // minified bundle. Fail closed for unknown renderer implementations.
        return /\.settings\.render\.enabled/.test(source)
            && /\.settings\.render\.depth/.test(source)
            && /\.settings\.render\.depth_ignore_hidden/.test(source)
            && /\.message_id\s*===/.test(source)
            && /\.reject\(/.test(source);
    });
}

export class RenderRecovery {
    constructor({ root, getContext, getChatId, enabled, isGenerating, events, onRepaired = () => {}, onError = () => {},
        Observer = globalThis.MutationObserver, delay = 300, deadDelay = 4000, now = () => Date.now() }) {
        Object.assign(this, { root, getContext, getChatId, enabled, isGenerating, events, onRepaired, onError, delay, deadDelay, now });
        this.pending = new Set(); this.attempts = new Map(); this.dead = new Map();
        this.timer = null; this.deadTimer = null; this.busy = false; this.stopped = false; this.epoch = 0;
        this.observer = new Observer(changes => {
            if (this.busy || this.stopped || !this.enabled() || this.isGenerating()) return;
            for (const change of changes) {
                const element = change.target.nodeType === 1 ? change.target : change.target.parentElement;
                const message = element?.closest?.('.mes');
                if (message) this.queue(message);
                for (const node of change.addedNodes || []) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches('.mes')) this.queue(node);
                    node.querySelectorAll('.mes').forEach(m => this.queue(m));
                }
            }
        });
        this.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'height'] });
        this.queueAll();
    }
    queue(element) {
        const id = Number(element.getAttribute('mesid'));
        const length = this.getContext().chat?.length || 0;
        if (!Number.isInteger(id) || id < Math.max(0, length - 30)) return;
        this.pending.add(id); this.schedule();
    }
    queueAll() { this.root.querySelectorAll('.mes[mesid]').forEach(m => this.queue(m)); }
    schedule() {
        if (this.stopped || !this.enabled()) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.scan(); }, this.delay);
    }
    broken(element, id) {
        const bare = [...element.querySelectorAll('.mes_text pre')].some(pre =>
            !pre.closest('.TH-render') && isFrontendText(pre.querySelector('code')?.textContent ?? pre.textContent));
        if (bare) { this.dead.delete(id); return true; }
        const empty = [...element.querySelectorAll('.mes_text .TH-render')].some(wrapper => {
            const iframe = wrapper.querySelector('iframe');
            // Hidden/collapsed messages are not broken merely because height is zero.
            return !iframe || (wrapper.getClientRects().length > 0 && iframe.getBoundingClientRect().height < 2);
        });
        if (!empty) { this.dead.delete(id); return false; }
        if (!this.dead.has(id)) this.dead.set(id, this.now());
        if (this.now() - this.dead.get(id) >= this.deadDelay) return true;
        if (!this.deadTimer) this.deadTimer = setTimeout(() => {
            this.deadTimer = null;
            for (const key of this.dead.keys()) this.pending.add(key);
            this.schedule();
        }, this.deadDelay + 100);
        return false;
    }
    async scan() {
        if (this.stopped || !this.enabled()) return;
        if (this.busy || this.isGenerating()) { this.schedule(); return; }
        this.busy = true;
        const epoch = this.epoch; const chatId = this.getChatId();
        const ids = [...this.pending]; this.pending.clear();
        try {
            for (const id of ids) {
                if (this.stopped || epoch !== this.epoch || chatId !== this.getChatId()) break;
                const ctx = this.getContext(); const message = ctx.chat?.[id];
                const element = this.root.querySelector(`.mes[mesid="${id}"]`);
                if (!message || !element || id < Math.max(0, ctx.chat.length - 30)) continue;
                if (element.querySelector('.mes_text')?.textContent.trim() === '...') continue;
                const signature = JSON.stringify([message.mes, message.extra?.display_text]);
                let record = this.attempts.get(id);
                if (!record || record.signature !== signature) {
                    record = { signature, count: 0 }; this.attempts.set(id, record);
                }
                if (!this.broken(element, id) || record.count >= 3) continue;
                const event = message.is_user ? this.events.USER_MESSAGE_RENDERED : this.events.CHARACTER_MESSAGE_RENDERED;
                const listeners = rendererListeners(ctx, event);
                if (!listeners.length) {
                    record.count = 3;
                    this.onError('Tavern Helper 렌더러를 찾지 못했습니다. 렌더러 활성화와 버전을 확인해 주세요.');
                    continue;
                }
                record.count++;
                const top = this.root.scrollTop;
                const bottom = this.root.scrollHeight - top - this.root.clientHeight < 60;
                for (const listener of listeners) {
                    if (this.stopped || epoch !== this.epoch || chatId !== this.getChatId()) break;
                    await listener.call(ctx.eventSource, id, 'icb_render_recovery');
                }
                if (this.stopped || epoch !== this.epoch || chatId !== this.getChatId() || this.getContext().chat?.[id] !== message) break;
                this.root.scrollTop = bottom ? this.root.scrollHeight : top;
                this.onRepaired(id);
                this.pending.add(id); this.schedule();
            }
        } catch (error) {
            this.onError(String(error.message || error));
            for (const id of ids) this.pending.add(id);
            this.schedule();
        } finally { this.busy = false; }
    }
    reset() {
        this.epoch++; clearTimeout(this.timer); clearTimeout(this.deadTimer);
        this.timer = null; this.deadTimer = null;
        this.pending.clear(); this.attempts.clear(); this.dead.clear(); this.queueAll();
    }
    destroy() {
        this.stopped = true; this.epoch++; this.observer.disconnect();
        clearTimeout(this.timer); clearTimeout(this.deadTimer);
        this.pending.clear(); this.attempts.clear(); this.dead.clear();
    }
}
