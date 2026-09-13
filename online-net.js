"use strict";

console.log("[Gwent Online] online-net.js loaded v1.4.3");

const OnlineNet = {
  DEFAULT_URL: null,
  socket: null,
  connected: false,
  role: null,
  code: null,
  pending: null,
  connectPromise: null,
  requestPromise: null,
  onMessage: null,
  onPeerJoined: null,
  onPeerLeft: null,

  serverURL() {
    const q = new URLSearchParams(location.search).get("server");
    const saved = localStorage.getItem("gwent-online-server");
    if (q) return q;
    // Ignore a stale localhost relay setting when the game itself is opened
    // from another machine/LXC address. localhost always means THIS browser.
    if (saved) {
      try {
        const u = new URL(saved);
        const localRelay = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
        const pageIsLocal = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
        if (!localRelay || pageIsLocal) return saved;
        localStorage.removeItem("gwent-online-server");
      } catch (_) {
        localStorage.removeItem("gwent-online-server");
      }
    }
    // Same-origin WebSocket endpoint. Using /ws makes LAN and reverse-proxy
    // setups deterministic and avoids collisions with ordinary HTTP requests.
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${location.host}/ws`;
  },

  async connect(url) {
    console.log("[Gwent Online] connect requested", url || this.serverURL());
    if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    const target = url || this.serverURL();
    this.connectPromise = new Promise((resolve, reject) => {
      let done = false;
      const ws = new WebSocket(target);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws.close(); } catch (_) {}
        reject(new Error("Connection timed out: " + target));
      }, 5000);
      const fail = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(new Error("Could not connect to multiplayer server: " + target));
        }
      };
      ws.onopen = () => {
        console.log("[Gwent Online] WebSocket open", target);
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.socket = ws;
        this.connected = true;
        resolve();
      };
      ws.onerror = (ev) => { console.error("[Gwent Online] WebSocket error", target, ev); fail(); };
      ws.onclose = () => this._closed();
      ws.onmessage = e => this._route(e.data);
    }).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  },

  createRoom() { return this._request({type:"create"}); },
  joinRoom(code) { return this._request({type:"join", code:String(code || "").trim().toUpperCase()}); },
  quickMatch() { return this._request({type:"quickmatch"}); },

  resetRoom() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.code) {
      console.log("[Gwent Online] leaving previous room", this.code);
      this._sendRaw({type:"leave"});
    }
    this.code = null;
    this.role = null;
  },

  _request(obj) {
    if (this.pending) return Promise.reject(new Error("Another room request is already in progress"));
    this.requestPromise = new Promise((resolve, reject) => {
      this.pending = {resolve, reject};
      this._sendRaw(obj);
    }).finally(() => { this.requestPromise = null; });
    return this.requestPromise;
  },

  send(data) { this._sendRaw({type:"msg", data}); },
  trace(data) {
    try {
      if (this.socket && this.socket.readyState === WebSocket.OPEN)
        this._sendRaw({type:"trace", data:data || {}});
    } catch (_) {}
  },
  leave() { this._sendRaw({type:"leave"}); this.code = null; this.role = null; },
  close() { try { this.socket && this.socket.close(); } catch (_) {} },

  _sendRaw(obj) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not connected");
    console.log("[Gwent Online] send", obj);
    this.socket.send(JSON.stringify(obj));
  },

  _route(raw) {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    console.log("[Gwent Online] recv", msg);
    if (msg.type === "created") { this.code = msg.code; this.role = "host"; return this._settle(null, msg.code); }
    if (msg.type === "joined") { this.code = msg.code; this.role = "guest"; return this._settle(null, msg.code); }
    if (msg.type === "error") return this._settle(new Error(msg.code || "server-error"));
    if (msg.type === "msg" && this.onMessage) return this.onMessage(msg.data);
    if (msg.type === "peer-joined" && this.onPeerJoined) return this.onPeerJoined();
    if (msg.type === "peer-left" && this.onPeerLeft) return this.onPeerLeft();
  },

  _settle(err, value) {
    const p = this.pending; this.pending = null;
    if (!p) return;
    err ? p.reject(err) : p.resolve(value);
  },

  _closed() {
    const hadRoom = !!this.code;
    this.socket = null; this.connected = false; this.code = null; this.role = null;
    if (this.pending) this._settle(new Error("connection-closed"));
    else if (hadRoom && this.onPeerLeft) this.onPeerLeft();
  }
};
