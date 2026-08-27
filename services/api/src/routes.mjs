export function registerRoutes(server, repository) {
  server.get('/api/health', async (_req, res) => {
    try {
      const db = await repository.getHealth();
      res.statusCode = 200;
      res.end(JSON.stringify({ ...db, service: 'aether-api' }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ status: 'degraded', database: 'unavailable' }));
    }
  });

  server.get('/api/traders/:wallet', async (req, res) => {
    const wallet = req.url.split('/').pop();
    const trader = await repository.getTraderByWallet(wallet);
    res.statusCode = trader ? 200 : 404;
    res.end(JSON.stringify(trader ?? { error: 'trader_not_found' }));
  });
}
