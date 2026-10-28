import { router as providerRouter } from '../../src/endpoints/backends/chat-completions.js';
import { BackgroundJobs } from './jobs.mjs';
import { requestBackend } from './backend.mjs';

export const info = { id: 'interpres-background', name: 'Interpres Background', description: 'Runs translation batches while the browser is suspended.' };
const queues = new Map();
let cleanupTimer;
export async function init(router) {
    router.use((req, res, next) => {
        const owner = req.user?.profile?.handle;
        if (!owner || !req.user?.directories) return res.sendStatus(401);
        req.interpresOwner = owner;
        next();
    });
    const queueFor = req => {
        const owner = req.interpresOwner;
        if (!queues.has(owner)) {
            // Capture only the server's authenticated user, never browser cookies.
            const user = req.user;
            queues.set(owner, new BackgroundJobs((payload, signal) => requestBackend(providerRouter, user, payload, signal), { limit: 3 }));
        }
        return queues.get(owner);
    };
    router.get('/status', (_req, res) => res.json({ version: 1, providers: ['vertexai', 'makersuite'] }));
    router.post('/jobs/:id', (req, res) => {
        try {
            const queue = queueFor(req);
            const job = queue.submit(req.interpresOwner, req.params.id, req.body);
            res.status(202).json(queue.view(job));
        } catch (error) { res.status(400).json({ error: String(error.message) }); }
    });
    router.get('/jobs/:id', (req, res) => {
        const queue = queues.get(req.interpresOwner);
        const job = queue?.get(req.interpresOwner, req.params.id);
        if (!job) return res.sendStatus(404);
        res.json(queue.view(job));
    });
    router.delete('/jobs/:id', (req, res) => {
        const queue = queues.get(req.interpresOwner);
        const job = queue?.get(req.interpresOwner, req.params.id);
        if (!job) return res.sendStatus(404);
        queue.cancel(job); res.json(queue.view(job));
    });
    cleanupTimer = setInterval(() => { for (const queue of queues.values()) queue.prune(); }, 60000);
    cleanupTimer.unref();
}
export function exit() { clearInterval(cleanupTimer); for (const queue of queues.values()) queue.close(); queues.clear(); }
