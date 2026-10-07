export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/socket.io/')) {
      return Response.json({
        mode: 'demo',
        error: 'Backend services are not connected to this dashboard preview.'
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    // Shareable tracking links (/track/<code>) are served by the tracking page.
    if (path.startsWith('/track/')) {
      return env.ASSETS.fetch(new Request(new URL('/track', request.url), request));
    }
    return env.ASSETS.fetch(request);
  }
};
