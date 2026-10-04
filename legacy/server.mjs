import http from 'node:http';
import { agent, sql } from './agent.mjs';

const PORT = process.env.PORT || 8080;

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });

http
  .createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const [{ now }] = await sql`SELECT now()`;
        return send(res, 200, { ok: true, db: now });
      }
      if (req.method === 'POST' && req.url === '/ask') {
        const { message, thread = 'default', resource = 'anon' } = await readJson(req);
        if (!message) return send(res, 400, { error: 'message is required' });
        const result = await agent.generate(message, { memory: { thread, resource } });
        return send(res, 200, { text: result.text });
      }
      send(res, 404, { error: 'Not found. Try GET /health or POST /ask {"message": "..."}' });
    } catch (err) {
      console.error(err);
      send(res, 500, { error: err.message });
    }
  })
  .listen(PORT, '0.0.0.0', () => console.log(`Listening on 0.0.0.0:${PORT}`));
