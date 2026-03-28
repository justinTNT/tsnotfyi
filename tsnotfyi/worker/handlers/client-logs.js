// Client log handler — captures browser logs via Worker console
// Visible in Cloudflare dashboard and `wrangler tail`
import { json } from '../router.js';

export async function handleClientLogs({ request }) {
  try {
    const body = await request.json();
    const entries = Array.isArray(body) ? body : [body];
    for (const entry of entries) {
      console.log(`[client] ${entry.level || 'info'} [${entry.channel || '?'}] ${entry.message || JSON.stringify(entry)}`);
    }
  } catch {
    // Malformed body — ignore
  }
  return json({ ok: true });
}
