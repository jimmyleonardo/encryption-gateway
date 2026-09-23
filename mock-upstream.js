import http from 'node:http';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    console.log('Mock upstream received:', req.method, req.url, 'headers:', req.headers.authorization, 'body:', body);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: true,
        profile: { id: 123, name: 'Budi Santoso', email: 'budi@example.com' },
      }),
    );
  });
});

server.listen(4000, () => console.log('Mock upstream API running on http://localhost:4000'));
