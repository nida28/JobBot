const urlsEl = document.getElementById('urls');
const startBtn = document.getElementById('start');
const statusEl = document.getElementById('status');

startBtn.addEventListener('click', async () => {
    const raw = urlsEl.value || '';
    const urls = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    if (!urls.length) {
        statusEl.textContent = 'No URLs found.';
        return;
    }

    startBtn.disabled = true;
    statusEl.textContent = `Sending ${urls.length} URL(s)…`;
    try {
        const res = await fetch('/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
            statusEl.textContent = `Error: ${data.error || res.statusText}`;
        } else {
            statusEl.textContent = `Batch started for ${data.count} URL(s). Check the browser window.`;
        }
    } catch (e) {
        statusEl.textContent = `Network error: ${e.message}`;
    } finally {
        startBtn.disabled = false;
    }
});
