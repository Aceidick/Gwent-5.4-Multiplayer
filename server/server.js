"use strict"

// Relay server for gwent-classic online multiplayer.
// Pairs two clients by a short room code — or automatically via quickmatch —
// and forwards "msg" frames between them verbatim. Holds no game logic and no
// persistent state; a room dies as soon as either side leaves or disconnects.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const WEB_ROOT = path.resolve(__dirname, "..");
const HOST = process.env.HOST || "0.0.0.0";
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L
const CODE_LENGTH = 5;

const rooms = new Map(); // code -> {host, guest, startedAt, messages}

const MAX_CLIENTS = 400;
const MAX_PER_IP = 10;
const ROOM_TTL_MS = 30 * 60 * 1000;
const MSG_RATE = 25;
const MSG_BURST = 50;
const MAX_BUFFER = 1024 * 1024;
const VALID_EVENTS = new Set(["mode-sp", "mode-mp", "mode-qm", "sp-game-started", "sp-game-finished", "mp-game-completed"]);
const EVENT_MAX_PER_IP = 60;
const EVENT_MAX_IPS = 5000;
const EVENT_WINDOW_MS = 60 * 1000;
// Optional comma-separated allow-list. If unset, accept browser origins from
// the LAN/public reverse proxy. Set ALLOWED_ORIGINS in production if desired.
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",").map(x => x.trim()).filter(Boolean)
);

const ipCounts = new Map();
let lastOverloadLog = 0;
let refusedSinceLog = 0;
let eventHits = new Map();

const MIME = {
  ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8",
  ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif",
  ".webp":"image/webp", ".svg":"image/svg+xml", ".ico":"image/x-icon",
  ".mp3":"audio/mpeg", ".wav":"audio/wav", ".ogg":"audio/ogg", ".ttf":"font/ttf", ".woff2":"font/woff2"
};

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.writeHead(200);
    res.end(JSON.stringify({ok:true, version:"1.4.3", clients:wss ? wss.clients.size : 0, rooms:rooms.size}));
    return;
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(204); res.end(); return;
  }
  if (req.method === "POST" && req.url === "/event") {
    const ip = clientIp(req);
    const hits = eventHits.get(ip) || 0;
    if (hits >= EVENT_MAX_PER_IP || (hits === 0 && eventHits.size >= EVENT_MAX_IPS)) {
      res.writeHead(429); res.end(); return;
    }
    eventHits.set(ip, hits + 1);
    let body = ""; let aborted = false;
    req.on("data", chunk => {
      if (aborted) return; body += chunk;
      if (body.length > 256) { aborted = true; req.destroy(); }
    });
    req.on("end", () => {
      if (aborted) return;
      try { const { type } = JSON.parse(body); if (VALID_EVENTS.has(type)) log(type); } catch (_) {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch (_) { res.writeHead(400); res.end("Bad request"); return; }
  if (pathname === "/") pathname = "/index.html";
  const rel = pathname.replace(/^\/+/, "");
  const filePath = path.resolve(WEB_ROOT, rel);
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    res.setHeader("Content-Type", MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(200);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

const wss = new WebSocketServer({
	server,
	path: "/ws",
	maxPayload: 32 * 1024,
	perMessageDeflate: false,
	verifyClient: ({ origin }, cb) => {
		// No allow-list configured: permit the page served by the LXC/LAN host.
		// If ALLOWED_ORIGINS is configured, enforce it strictly.
		const ok = ALLOWED_ORIGINS.size === 0 || !origin || ALLOWED_ORIGINS.has(origin);
		cb(ok, 403, "forbidden");
	}
});

function log(event, fields = {}) {
	const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("  ");
	console.log(`[${new Date().toISOString()}] ${event.padEnd(14)} ${parts}`);
}

function makeCode() {
	let code;
	do {
		code = "";
		for (let i = 0; i < CODE_LENGTH; i++)
			code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
	} while (rooms.has(code));
	return code;
}

function send(ws, obj) {
	if (ws && ws.readyState === ws.OPEN) {
		if (ws.bufferedAmount > MAX_BUFFER) {
			ws.terminate();
			return;
		}
		ws.send(JSON.stringify(obj));
	}
}


function reject(ws, code, context = {}) {
  log("request-reject", { ip: ws.ip || "?", room: ws.room || "-", error: code, ...context });
  send(ws, { type: "error", code });
}

function peerOf(ws) {
	const room = rooms.get(ws.room);
	if (!room)
		return null;
	return room.host === ws ? room.guest : room.host;
}

function clientIp(req) {
	const xff = req.headers["x-forwarded-for"];
	if (xff) {
		const parts = xff.split(",");
		return parts[parts.length - 1].trim();
	}
	return req.socket.remoteAddress || "?";
}

function allowMessage(ws) {
	const now = Date.now();
	ws.tokens = Math.min(MSG_BURST, ws.tokens + (now - ws.lastRefill) / 1000 * MSG_RATE);
	ws.lastRefill = now;
	if (ws.tokens < 1)
		return false;
	ws.tokens -= 1;
	return true;
}

function destroyRoom(ws, notifyPeer, reason) {
	const room = rooms.get(ws.room);
	ws.room = null;
	if (!room)
		return;
	rooms.delete(room.code);
	const peer = room.host === ws ? room.guest : room.host;
	if (peer) {
		peer.room = null;
		if (notifyPeer)
			send(peer, { type: "peer-left" });
	}
	if (room.startedAt) {
		const mins = Math.round((Date.now() - room.startedAt) / 60000);
		log("game-ended", { code: room.code, messages: room.messages, duration: `${mins}m`, reason });
	} else {
		log("room-closed", { code: room.code, reason });
	}
}

wss.on("connection", (ws, req) => {
	log("ws-connected", { ip: clientIp(req), origin: req.headers.origin || "-" });
	if (wss.clients.size > MAX_CLIENTS) {
		refusedSinceLog++;
		const now = Date.now();
		if (now - lastOverloadLog > 60000) {
			log("overloaded", { clients: wss.clients.size, refused: refusedSinceLog });
			lastOverloadLog = now;
			refusedSinceLog = 0;
		}
		ws.close(1013, "overloaded");
		return;
	}
	const ip = clientIp(req);
	if ((ipCounts.get(ip) || 0) >= MAX_PER_IP) {
		ws.close(1013, "too-many");
		return;
	}
	ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
	ws.ip = ip;
	ws.isAlive = true;
	ws.room = null;
	ws.tokens = MSG_BURST;
	ws.lastRefill = Date.now();
	ws.on("pong", () => ws.isAlive = true);

	ws.on("message", raw => {
		if (!allowMessage(ws))
			return ws.close(1008, "rate");
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch (e) {
			return reject(ws, "bad-request");
		}
		switch (msg.type) {
			case "create": {
				if (ws.room)
					return reject(ws, "already-in-room");
				const code = makeCode();
				rooms.set(code, { code: code, host: ws, guest: null, quickmatch: false, startedAt: null, createdAt: Date.now(), messages: 0 });
				ws.room = code;
				send(ws, { type: "created", code: code });
				log("room-created", { code });
				break;
			}
			case "quickmatch": {
				if (ws.room)
					return reject(ws, "already-in-room");
				// Pair with the searcher who has been waiting the longest, if any.
				// Skip hosts whose socket is closing but not yet reaped.
				let match = null;
				for (const room of rooms.values())
					if (room.quickmatch && !room.guest && room.host.readyState === room.host.OPEN &&
							(!match || room.createdAt < match.createdAt))
						match = room;
				if (match) {
					match.guest = ws;
					match.startedAt = Date.now();
					ws.room = match.code;
					send(ws, { type: "joined", code: match.code });
					send(match.host, { type: "peer-joined" });
					log("peer-paired", { code: match.code, mode: "quickmatch" });
				} else {
					const code = makeCode();
					rooms.set(code, { code: code, host: ws, guest: null, quickmatch: true, startedAt: null, createdAt: Date.now(), messages: 0 });
					ws.room = code;
					send(ws, { type: "created", code: code });
					send(ws, { type: "qm-status", online: wss.clients.size });
					log("qm-waiting", { code });
				}
				break;
			}
			case "join": {
                const requestedCode = String(msg.code || "").trim().toUpperCase();
                log("join-attempt", { ip: ws.ip || "?", code: requestedCode });
				if (ws.room)
					return reject(ws, "already-in-room");
				const code = requestedCode;
				const room = rooms.get(code);
				if (!room)
					return reject(ws, "not-found", { requested: code });
				if (room.guest)
					return reject(ws, "full", { requested: code });
				room.guest = ws;
				room.startedAt = Date.now();
				ws.room = code;
				send(ws, { type: "joined", code: code });
				send(room.host, { type: "peer-joined" });
				log("peer-paired", { code });
				break;
			}
			case "trace": {
				const room = rooms.get(ws.room);
				const role = room ? (room.host === ws ? "host" : "guest") : "-";
				const d = (msg && msg.data && typeof msg.data === "object") ? msg.data : {};
				const fields = {
					code: ws.room || "-", from: role, stage: String(d.stage || "?"),
					seq: d.seq == null ? "-" : d.seq, curr: d.curr || "-", actor: d.actor || "-", next: d.next || "-",
					card: d.card || "-", target: d.target || "-", err: d.err ? String(d.err).slice(0,180) : "-"
				};
				log("client-trace", fields);
				break;
			}
			case "msg": {
				const peer = peerOf(ws);
				if (!peer)
					return reject(ws, "no-peer");
				const eventType = msg && msg.data && typeof msg.data.t === "string" ? msg.data.t : "data";
				if (["lobby-ready", "lobby-unready", "lobby-start", "lobby-start-ack", "match-forfeit", "match-stop", "action", "turn-state", "popup-choice", "choice", "choice-end", "choice-commit", "rearrange-card", "rearrange-row", "rearrange-end", "ability-target", "power-card", "number-choice", "destination"].includes(eventType)) {
					const detail = { code: ws.room, from: rooms.get(ws.room)?.host === ws ? "host" : "guest" };
					if (eventType === "lobby-start" || eventType === "lobby-start-ack") {
						detail.seed = msg.data.seed;
						detail.firstRole = msg.data.firstRole;
					}
					if (eventType === "action") {
						detail.seq = msg.data.seq;
						detail.actor = msg.data.actorRole;
						detail.action = msg.data.a;
					}
					if (eventType === "turn-state") {
						detail.seq = msg.data.seq;
						detail.actor = msg.data.actorRole;
						detail.next = msg.data.nextRole;
					}
					if (msg.data.decision) {
						detail.decision = msg.data.decision || "-";
						if (eventType === "popup-choice") detail.yes = !!msg.data.yes;
						if (eventType === "choice") detail.card = msg.data.card && msg.data.card.key ? msg.data.card.key : "-";
					}
					log("relay-" + eventType, detail);
				}
				if (eventType === "lobby-start-ack")
					log("match-handshake", { code: ws.room, state: "complete", seed: msg.data.seed, firstRole: msg.data.firstRole });
				send(peer, { type: "msg", data: msg.data });
				const room = rooms.get(ws.room);
				if (room) room.messages++;
				break;
			}
			case "leave":
                log("leave-room", { ip: ws.ip || "?", code: ws.room || "-" });
				destroyRoom(ws, true, "leave");
				break;
			default:
				reject(ws, "bad-request");
		}
	});

	ws.on("close", (code, reason) => {
		log("ws-closed", { ip: ws.ip || "?", code, reason: String(reason || "-") });
		const n = (ipCounts.get(ws.ip) || 1) - 1;
		if (n <= 0)
			ipCounts.delete(ws.ip);
		else
			ipCounts.set(ws.ip, n);
		destroyRoom(ws, true, "disconnect");
	});
});

// Reap dead connections (browsers answer pings automatically)
setInterval(() => {
	const now = Date.now();
	const stale = [];
	for (const room of rooms.values())
		if (!room.startedAt && now - room.createdAt > ROOM_TTL_MS)
			stale.push(room);
	for (const room of stale) {
		const host = room.host;
		destroyRoom(host, false, "idle-timeout");
		if (host)
			host.close(1013, "idle");
	}
	for (const ws of wss.clients) {
		if (!ws.isAlive) {
			ws.terminate();
			continue;
		}
		ws.isAlive = false;
		ws.ping();
	}
	for (const room of rooms.values())
		if (room.quickmatch && !room.guest)
			send(room.host, { type: "qm-status", online: wss.clients.size });
}, 30000);

setInterval(() => { eventHits = new Map(); }, EVENT_WINDOW_MS);

server.listen(PORT, HOST, () => log("server-start", { host: HOST, port: PORT, version: "1.4.3" }));
