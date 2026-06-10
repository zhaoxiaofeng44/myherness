import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { isLanEligible, getLanAddresses, DISCOVERY_PORT } from './networkUtils.js';

export class PeerManager extends EventEmitter {
  constructor({ httpPort }) {
    super();
    this.httpPort = httpPort;
    this.instanceId = crypto.randomBytes(8).toString('hex');
    this.hostname = os.hostname();
    this.peers = new Map();
    this.socket = null;
    this._heartbeatTimer = null;
    this._gcTimer = null;
    this._sseBridges = new Map();
    this._active = false;
  }

  start() {
    if (!isLanEligible()) {
      console.log('[PeerManager] 非 192.168.x.x 网段，单机模式');
      return;
    }

    this._active = true;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type !== 'claude-console-beacon') return;
        if (data.id === this.instanceId) return;

        const peerId = data.id;
        const existing = this.peers.get(peerId);
        const peer = {
          id: peerId,
          name: data.name || rinfo.address,
          host: rinfo.address,
          httpPort: data.httpPort || 4477,
          version: data.version || 1,
          lastSeen: Date.now(),
        };

        if (!existing) {
          this.peers.set(peerId, peer);
          console.log(`[PeerManager] 发现节点: ${peer.name} (${peer.host}:${peer.httpPort})`);
          this.emit('peer:added', peer);
        } else {
          Object.assign(existing, peer);
        }
      } catch {}
    });

    sock.on('error', (err) => {
      console.error('[PeerManager] UDP error:', err.message);
    });

    sock.bind(DISCOVERY_PORT, () => {
      sock.setBroadcast(true);
      console.log(`[PeerManager] 监听 UDP:${DISCOVERY_PORT}，实例ID: ${this.instanceId}`);
    });

    this.socket = sock;

    this._heartbeatTimer = setInterval(() => this._sendBeacon(), 5000);
    setTimeout(() => this._sendBeacon(), 500);

    this._gcTimer = setInterval(() => this._gc(), 5000);
  }

  _sendBeacon() {
    if (!this.socket) return;
    const beacon = JSON.stringify({
      type: 'claude-console-beacon',
      id: this.instanceId,
      name: this.hostname,
      httpPort: this.httpPort,
      version: 1,
    });
    const buf = Buffer.from(beacon);

    const addrs = getLanAddresses();
    for (const { address } of addrs) {
      const parts = address.split('.');
      const broadcast = parts[0] + '.' + parts[1] + '.' + parts[2] + '.255';
      try {
        this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, broadcast);
      } catch {}
    }
  }

  _gc() {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > 15000) {
        this.peers.delete(id);
        console.log(`[PeerManager] 节点离线: ${peer.name} (${peer.host})`);
        this._closeBridge(id);
        this.emit('peer:removed', peer);
      }
    }
  }

  getPeers() {
    return Array.from(this.peers.values());
  }

  getPeer(peerId) {
    return this.peers.get(peerId) || null;
  }

  isActive() {
    return this._active;
  }

  async proxyRequest(peerId, method, path, body) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('节点不在线');

    const url = `http://${peer.host}:${peer.httpPort}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      };
      if (body && method !== 'GET') {
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const resp = await fetch(url, opts);
      const text = await resp.text();
      return { status: resp.status, body: text };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('远端请求超时');
      throw new Error('远端请求失败: ' + err.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  openBridge(peerId, onEvent) {
    if (this._sseBridges.has(peerId)) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;

    const url = `http://${peer.host}:${peer.httpPort}/api/events`;
    const bridge = { controller: new AbortController(), reconnectTimer: null, retries: 0 };
    this._sseBridges.set(peerId, bridge);

    const connect = () => {
      const req = http.get(url, { signal: bridge.controller.signal }, (res) => {
        if (res.statusCode !== 200) {
          scheduleReconnect();
          return;
        }
        bridge.retries = 0;
        let buffer = '';
        let currentEvent = 'message';

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const dataStr = line.slice(6);
              try {
                const data = JSON.parse(dataStr);
                onEvent(peerId, currentEvent, data);
              } catch {}
              currentEvent = 'message';
            } else if (line === '') {
              currentEvent = 'message';
            }
          }
        });

        res.on('end', () => scheduleReconnect());
        res.on('error', () => scheduleReconnect());
      });

      req.on('error', () => scheduleReconnect());
    };

    const scheduleReconnect = () => {
      if (bridge.controller.signal.aborted) return;
      bridge.retries++;
      const delay = Math.min(1000 * Math.pow(2, bridge.retries - 1), 30000);
      bridge.reconnectTimer = setTimeout(connect, delay);
    };

    connect();
  }

  _closeBridge(peerId) {
    const bridge = this._sseBridges.get(peerId);
    if (!bridge) return;
    bridge.controller.abort();
    if (bridge.reconnectTimer) clearTimeout(bridge.reconnectTimer);
    this._sseBridges.delete(peerId);
  }

  stop() {
    this._active = false;
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._gcTimer) clearInterval(this._gcTimer);
    for (const peerId of this._sseBridges.keys()) {
      this._closeBridge(peerId);
    }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
  }
}
