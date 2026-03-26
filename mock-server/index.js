const { WebSocketServer } = require('ws');
const { createHmac, randomBytes } = require('node:crypto');

const SESSION_KEY = 'mock-key-for-dev';
const clients = new Map();

function signMessage(msg) {
  const material = `${msg.id}|${msg.from}|${msg.to}|${msg.content}|${msg.timestamp}|${msg.nonce}`;
  return createHmac('sha256', SESSION_KEY).update(material).digest('hex');
}

function sendInbound(targetAgentId, fromAgentId, content) {
  const target = clients.get(targetAgentId);
  if (!target) {
    console.error(`target not connected: ${targetAgentId}`);
    return;
  }
  const msg = {
    id: randomBytes(8).toString('hex'),
    from: fromAgentId,
    to: targetAgentId,
    type: 'text',
    content,
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('hex')
  };
  msg.signature = signMessage(msg);
  target.send(JSON.stringify(msg));
}

const wss = new WebSocketServer({ port: 19000, host: '127.0.0.1' });
console.log('mock server listening on ws://127.0.0.1:19000');
console.log('stdin usage: <to> <content>');

wss.on('connection', (ws, req) => {
  const agentId = req.headers['x-agent-id'] || 'local-agent';
  clients.set(agentId, ws);
  ws.send(JSON.stringify({ type: 'session', session_key: SESSION_KEY, expires_in: 3600 }));

  ws.on('message', (raw) => {
    const data = JSON.parse(String(raw));
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    const target = clients.get(data.to);
    if (target) target.send(JSON.stringify(data));
  });

  ws.on('close', () => {
    clients.delete(agentId);
  });
});

process.stdin.on('data', (chunk) => {
  const input = String(chunk).trim();
  if (!input) return;
  const [to, ...rest] = input.split(' ');
  const content = rest.join(' ');
  sendInbound(to, 'mock-remote', content);
});
