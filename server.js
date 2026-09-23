import { WebSocketServer, WebSocket } from 'ws';
import 'dotenv/config';
import express from 'express';
import http from 'http';
import axios from 'axios';

const app = express();
const server = http.createServer(app);
const password = process.env.WEBSOCKET_PASSWORD;

// The ESP streams a whole pattern file back when a client asks for one
// (WSCmdType_PATTERN_DATA), and esp_websocket_client splits any send larger
// than its tx buffer into 16 KiB frames. The old 10 KB cap therefore rejected
// the very first frame of every pattern download and closed the ESP's
// connection with 1009 — which looked like random ESP disconnects and made the
// canvas preview unable to ever load the pattern it was trying to draw. The
// cap stays (connections are password-gated, but an unbounded one is still a
// memory hazard), just above anything this protocol legitimately sends.
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });

let espSocket = null;
let webSockets = [];

const WSCmdType_ESP_STATE = 0x0f;

// How often every webapp is told, unprompted, whether the ESP is there. This
// doubles as proof that the relay itself is alive: a client that stops hearing
// it knows its own connection is dead without waiting for TCP to notice.
const STATE_BROADCAST_INTERVAL_MS = 5000;
// The ESP heartbeats every 5s; three missed in a row means it's gone.
const ESP_TIMEOUT_MS = 15000;
// Low-level ws ping, to prune half-open webapp sockets and keep proxies from
// idling connections out.
const PING_INTERVAL_MS = 30000;
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

let espLastSeen = 0;
let lastKeepAlivePing = 0;

function isSocketOpen(socket) {
	return socket && socket.readyState === WebSocket.OPEN;
}

// Render's free tier spins the service down when idle, so it used to ping
// itself to stay awake. That is a workaround for one host, not something the
// relay needs, so it only runs if KEEPALIVE_URL is set — unset (e.g. on a VPS,
// where nothing spins down) it does nothing.
const keepAliveUrl = process.env.KEEPALIVE_URL;

function keepServerAlive() {
	if (!keepAliveUrl) return;
	if (Date.now() - lastKeepAlivePing < KEEP_ALIVE_INTERVAL_MS) {
		return;
	}

	lastKeepAlivePing = Date.now();
	console.log('Sending HTTP keepalive ping');
	axios
		.get(keepAliveUrl)
		.then((response) => {
			console.log('HTTP ping successful:', response.status);
		})
		.catch((error) => {
			console.error('Error pinging server:', error.message);
		});
}

function broadcastEspState() {
	const payload = Buffer.from([WSCmdType_ESP_STATE, isSocketOpen(espSocket) ? 1 : 0]);
	webSockets.forEach((webSocket) => {
		if (isSocketOpen(webSocket)) {
			webSocket.send(payload);
		}
	});
}

function cleanupESP() {
	if (isSocketOpen(espSocket)) {
		espSocket.terminate();
	}
	espSocket = null;
	broadcastEspState();
}

// One timer for the whole process rather than one started per ESP connection:
// it keeps running (and keeps clients informed) while no ESP is connected at
// all, which is exactly the window where a client most needs to be told.
setInterval(() => {
	if (espSocket && Date.now() - espLastSeen > ESP_TIMEOUT_MS) {
		console.log('Esp did not respond for too long, terminating.');
		cleanupESP();
	} else {
		broadcastEspState();
	}
	keepServerAlive();
}, STATE_BROADCAST_INTERVAL_MS);

// Webapps only — the ESP's own liveness is already covered by its heartbeat,
// and reaping it over a missed pong would just add another way for an already
// marginal link to get torn down.
setInterval(() => {
	webSockets.forEach((socket) => {
		if (!isSocketOpen(socket)) return;
		if (socket.isAlive === false) {
			console.log('Terminating unresponsive webapp socket');
			socket.terminate();
			return;
		}
		socket.isAlive = false;
		socket.ping();
	});
}, PING_INTERVAL_MS);

wss.on('error', (error) => {
	console.log('Server error, name:', error.name, ', message:', error.message);
});

wss.on('connection', (ws, req) => {
	let protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());

	if (protocols.length < 2 || protocols[1] != password) {
		console.log('Unauthorized connection: ', protocols);
		ws.close(1008, 'Unauthorized connection');
		return;
	}

	ws.isAlive = true;
	ws.on('pong', () => {
		ws.isAlive = true;
	});

	if (protocols[0] === 'webapp') {
		console.log('Webapp connected');
		webSockets.push(ws);

		ws.send(Buffer.from([WSCmdType_ESP_STATE, isSocketOpen(espSocket) ? 1 : 0]));

		ws.on('close', () => {
			console.log('Webapp disconnected');
			webSockets = webSockets.filter((client) => client !== ws);
		});

		ws.on('message', (data) => {
			if (isSocketOpen(espSocket)) {
				espSocket.send(data);
			}
		});

		ws.on('error', (err) => {
			console.error('Webapp error, terminating:', err);
			webSockets = webSockets.filter((client) => client !== ws);
			ws.terminate();
		});
	}

	if (protocols[0] === 'esp') {
		console.log('Esp connected');
		if (isSocketOpen(espSocket) && espSocket !== ws) {
			// An ESP that reconnected before its previous socket was reaped
			// would otherwise leave a zombie behind whose eventual 'close'
			// tears down the *new* connection via cleanupESP().
			console.log('Replacing a previous ESP connection');
			espSocket.removeAllListeners();
			espSocket.terminate();
		}
		espSocket = ws;
		espLastSeen = Date.now();

		broadcastEspState();

		ws.on('message', (data) => {
			espLastSeen = Date.now();
			// Heartbeats are the ESP's liveness proof, not traffic to relay —
			// clients learn about them through the periodic broadcast above.
			if (data[0] == WSCmdType_ESP_STATE) {
				return;
			}
			webSockets.forEach((webSocket) => {
				if (isSocketOpen(webSocket)) {
					webSocket.send(data);
				}
			});
		});

		ws.on('close', () => {
			console.log('Esp disconnected');
			if (espSocket === ws) cleanupESP();
		});

		ws.on('error', (err) => {
			console.error('ESP error:', err);
			if (espSocket === ws) cleanupESP();
		});
	}
});

app.get('/ping', (req, res) => {
	console.log('keepalive ping received');
	res.status(200).send('OK');
});

const port = process.env.PORT || 8090;
server.listen(port, () => {
	console.log(`Server and WebSocket listening on port ${port}`);
});
