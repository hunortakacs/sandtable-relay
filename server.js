import { WebSocketServer, WebSocket } from 'ws';
import 'dotenv/config';
import express from 'express';
import http from 'http';
import axios from 'axios';

const app = express();
const server = http.createServer(app);
const password = process.env.WEBSOCKET_PASSWORD;
const wss = new WebSocketServer({ server, maxPayload: 10000 });

let espSocket = null;
let webSockets = [];

const WSCmdType_ESP_STATE = 0x0f;
const HEARTBEAT_INTERVAL_MS = 5000;
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

let espLastSeen = 0;
let lastKeepAlivePing = 0;
let heartbeatInterval = null;

function keepServerAlive() {
	if(Date.now() - lastKeepAlivePing < KEEP_ALIVE_INTERVAL_MS) {
		return;
	}

	lastKeepAlivePing = Date.now();
	console.log("Sending HTTP keepalive ping");
	axios
		.get('https://sandtable-websocket.onrender.com/ping')
		.then((response) => {
			console.log('HTTP ping successful:', response.status);
		})
		.catch((error) => {
			console.error('Error pinging server:', error);
		});
}

function cleanupESP() {
	if (heartbeatInterval !== null) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
	}

	if (isSocketOpen(espSocket)) {
		espSocket.terminate();
	}
	espSocket = null;

	webSockets.forEach((webSocket) => {
		if (isSocketOpen(webSocket)) {
			webSocket.send(Buffer.from([WSCmdType_ESP_STATE, 0]));
		}
	});
}

function isSocketOpen(socket) {
	return socket && socket.readyState === WebSocket.OPEN;
}

function startESPHeartbeatCheck() {
	if (heartbeatInterval !== null) clearInterval(heartbeatInterval);

	espLastSeen = Date.now();
	heartbeatInterval = setInterval(() => {
		if (Date.now() - espLastSeen > HEARTBEAT_INTERVAL_MS * 3) {
			console.log('Esp did not respond for too long, terminating.');
			cleanupESP();
			return;
		}
	}, HEARTBEAT_INTERVAL_MS);
}

wss.on('error', (error) => {
	console.log('Server error, name:', error.name, ', message:', error.message);
});

wss.on('connection', (ws, req) => {
	let protocols = (req.headers['sec-websocket-protocol'] || '')
		.split(',')
		.map((p) => p.trim());

	if (protocols.length < 2 || protocols[1] != password) {
		console.log('Unauthorized connection: ', protocols);
		ws.close(1008, 'Unauthorized connection');
		return;
	}

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
		espSocket = ws;
		startESPHeartbeatCheck();

		webSockets.forEach((webSocket) => {
			if (isSocketOpen(webSocket)) {
				webSocket.send(Buffer.from([WSCmdType_ESP_STATE, 1]));
			}
		});

		ws.on('message', (data) => {
			if (data[0] == WSCmdType_ESP_STATE) {
				espLastSeen = Date.now();
				keepServerAlive();
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
			cleanupESP();
		});

		ws.on('error', (err) => {
			console.error('ESP error:', err);
			cleanupESP();
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
