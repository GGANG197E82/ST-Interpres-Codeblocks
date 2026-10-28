const ROOT = '/api/plugins/interpres-background';

export async function runBackgroundBatch(spec, { headers, signal, onProgress = () => {}, fetchFn = fetch, storage = globalThis.sessionStorage, scope = '' } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('번역을 취소했습니다.'), { name: 'AbortError' });
    const bytes = new TextEncoder().encode(JSON.stringify(spec));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    const storageKey = 'icb-background:' + (scope || hash);
    const keys = spec.tasks.map(task => JSON.stringify([task.body, task.user]));
    let saved;
    try { saved = JSON.parse(storage?.getItem(storageKey) || 'null'); } catch { /* private browsing */ }
    let id = saved?.id;
    if (!/^[a-f0-9]{64}$/.test(id || '')) {
        id = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
    }
    let url = ROOT + '/jobs/' + id;
    const cancel = () => { fetchFn(url, { method: 'DELETE', headers, keepalive: true }).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    const read = async response => {
        if (response.status === 404) throw new Error('백그라운드 서버 플러그인을 설치하고 SillyTavern 서버를 재시작해 주세요.');
        if (!response.ok) throw new Error('백그라운드 번역 서버 요청 실패 (HTTP ' + response.status + ')');
        return response.json();
    };
    const wait = () => new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); globalThis.document?.removeEventListener('visibilitychange', visible); resolve(); };
        const abort = () => { done(); reject(Object.assign(new Error('번역을 취소했습니다.'), { name: 'AbortError' })); };
        const visible = () => { if (!document.hidden) done(); };
        const timer = setTimeout(done, 1500);
        signal?.addEventListener('abort', abort, { once: true });
        globalThis.document?.addEventListener('visibilitychange', visible);
        if (signal?.aborted) abort();
    });
    try {
        let state, indices, restart = false;
        // A reload can already have some completed parts in chat metadata. Attach
        // to the original server batch instead of paying for its remaining parts twice.
        if (saved?.id === id && Array.isArray(saved.keys)) {
            const response = await fetchFn(url, { headers, signal });
            if (response.ok) {
                const previous = await response.json();
                const mapping = keys.map(key => saved.keys.indexOf(key));
                if (['running', 'completed'].includes(previous.status) && mapping.every(n => n >= 0)) {
                    state = previous; indices = mapping;
                } else restart = true;
            }
        }
        if (!state) {
            if (restart || (saved?.hash && saved.hash !== hash)) {
                id = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
                url = ROOT + '/jobs/' + id;
            }
            try { storage?.setItem(storageKey, JSON.stringify({ id, hash, keys })); } catch { /* same-page use still works */ }
            state = await read(await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(spec), signal }));
        }
        while (true) {
            if (signal?.aborted) throw Object.assign(new Error('번역을 취소했습니다.'), { name: 'AbortError' });
            const current = indices ? { ...state, results: indices.map(n => state.results[n]), errors: indices.map(n => state.errors[n]) } : state;
            onProgress(current);
            if (state.status !== 'running') {
                try { storage?.removeItem(storageKey); } catch { /* ignore */ }
                if (state.status === 'cancelled') throw Object.assign(new Error('번역을 취소했습니다.'), { name: 'AbortError' });
                if (state.status === 'failed') throw new Error('백그라운드 번역 일부 실패: ' + (state.errors.find(Boolean) || '서버 로그를 확인하세요.'));
                return current.results;
            }
            await wait();
            state = await read(await fetchFn(url, { headers, signal }));
        }
    } finally { signal?.removeEventListener('abort', cancel); }
}
