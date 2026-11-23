// Sanctuary Computer (quickbooks-mcp-291): preload for process tests: any socket connect or DNS lookup prints network-reached and exits 97.
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

const reached = (label) =>
  function trapped() {
    process.stdout.write(`network-reached ${label}\n`);
    process.exit(97);
  };
net.Socket.prototype.connect = reached('net.Socket.connect');
tls.connect = reached('tls.connect');
dns.lookup = reached('dns.lookup');
dns.promises.lookup = reached('dns.promises.lookup');
