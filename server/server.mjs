// server/server.mjs
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatch } from './runner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(express.json({ limit: '1mb' }));

let running = false;

app.post('/jobs', async (req, res) => {
    try {
        const urls = Array.isArray(req.body?.urls)
            ? req.body.urls.map(u => String(u).trim()).filter(Boolean)
            : [];

        if (!urls.length) return res.status(400).json({ ok: false, error: 'No URLs provided' });
        if (running) return res.status(409).json({ ok: false, error: 'Batch already running. Try again later.' });

        console.log(`[easyapply] Received batch: ${urls.length} URL(s)`);
        running = true;

        runBatch(urls)
            .catch(err => console.error('[easyapply] Batch error:', err))
            .finally(() => { running = false; });

        res.json({ ok: true, count: urls.length });
    } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
    }
});

app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`[easyapply] Web UI on http://localhost:${PORT}`);
});
