import os from 'node:os';
import dns from 'node:dns/promises';

export const DISCOVERY_PORT = 44770;

export function checkNetwork(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    dns.resolve4('baidu.com')
      .then(() => { clearTimeout(timer); resolve(true); })
      .catch(() => {
        dns.resolve4('google.com')
          .then(() => { clearTimeout(timer); resolve(true); })
          .catch(() => { clearTimeout(timer); resolve(false); });
      });
  });
}

export function getLanAddresses() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.')) {
        result.push({ address: iface.address, name });
      }
    }
  }
  return result;
}

export function isLanEligible() {
  return getLanAddresses().length > 0;
}
