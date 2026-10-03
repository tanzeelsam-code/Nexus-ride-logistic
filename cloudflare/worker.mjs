export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/socket.io/')) {
      return Response.json({
        mode: 'demo',
        error: 'Backend services are not connected to this dashboard preview.'
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  }
};
