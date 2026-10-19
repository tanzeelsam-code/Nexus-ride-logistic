import { openRuntime } from './runtime.mjs';
import { handleAsNodeRequest } from 'cloudflare:node';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith('/socket.io/')) return Response.json({ error: 'Use the authenticated events API.' }, { status: 404 });
    if (path.startsWith('/api/') || ['/health','/ready','/metrics'].includes(path)) {
      let runtime;
      try {
        runtime = await openRuntime(env);
        return await runtime.run(async () => {
        const forwarded = new Request(request);
        forwarded.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '127.0.0.1');
        const response = await handleAsNodeRequest(runtime.port, forwarded);
        // Consume the response before closing its per-request HTTP server.
        const body = request.method === 'HEAD' || [204,304].includes(response.status) ? null : await response.arrayBuffer();
        await runtime.flush();
        if (request.method === 'POST') ctx.waitUntil((async () => {
          const background = await openRuntime(env);
          try { await background.run(() => background.processBackground(1)); }
          finally { await background.close(); }
        })());
        const headers = new Headers(response.headers);
        headers.set('Cache-Control','no-store');
        return new Response(body, { status:response.status, headers });
        });
      } catch (error) {
        console.error('API request failed', error.stack);
        return Response.json({ error:'Service temporarily unavailable.' }, { status:503,headers:{'Cache-Control':'no-store'} });
      } finally { if (runtime) await runtime.close(); }
    }
    if (path.startsWith('/track/')) return env.ASSETS.fetch(new Request(new URL('/track',request.url),request));
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event,env) {
    const runtime = await openRuntime(env);
    try {
      await runtime.run(async () => {
      await runtime.sweepDispatch();
      await runtime.flush();
      await runtime.processBackground();
      await runtime.db.query('DELETE FROM nexora_private.runtime_kv WHERE expires_at < NOW()');
      await runtime.db.query("DELETE FROM nexora_private.events WHERE created_at < NOW()-INTERVAL '1 day'");
      });
    } finally { await runtime.close(); }
  }
};
