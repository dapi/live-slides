import { connect, createServer, type Socket } from "node:net";

/**
 * Bun's WebSocket client can use an HTTP proxy but cannot choose how its host name resolves
 * and does not speak SOCKS5. Both needs are met by a loopback HTTP CONNECT proxy that opens
 * each tunnel in its own way. TLS stays end to end between the client and the far host.
 */
function startBridge(open: (client: Socket, host: string, port: number) => void): Promise<string> {
  const server = createServer((client) => {
    client.on("error", () => {});
    client.once("data", (head) => {
      const target = head.toString("latin1").match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP/);
      if (!target) return client.destroy();
      open(client, target[1], Number(target[2]));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

/** Closes both ends together and returns the upstream socket. */
function pair(client: Socket, upstream: Socket): Socket {
  const fail = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", fail);
  client.on("error", fail);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  return upstream;
}

function established(client: Socket, upstream: Socket): void {
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  client.pipe(upstream);
  upstream.pipe(client);
}

/** Forwards every tunnel through a SOCKS5 proxy without authentication. Returns the proxy URL. */
export function startSocksBridge(socksUrl: string): Promise<string> {
  const socks = new URL(socksUrl);
  return startBridge((client, host, port) => {
    const upstream = pair(client, connect(Number(socks.port || 1080), socks.hostname));
    let step: "greeting" | "request" = "greeting";
    upstream.once("connect", () => upstream.write(Uint8Array.of(5, 1, 0))); // SOCKS5, one method: no auth
    upstream.on("data", function onData(chunk: Buffer) {
      if (chunk[0] !== 5 || chunk[1] !== 0) return void upstream.destroy();
      if (step === "greeting") {
        step = "request";
        // CONNECT to a domain name, so the name resolves at the far end of the tunnel.
        const name = Buffer.from(host, "latin1");
        upstream.write(Buffer.concat([Uint8Array.of(5, 1, 0, 3, name.length), name, Uint8Array.of(port >> 8, port & 0xff)]));
      } else {
        upstream.off("data", onData);
        established(client, upstream);
      }
    });
  });
}

/**
 * Connects every tunnel to the address a DNS-over-HTTPS resolver gives for the host. With a
 * Control D endpoint as the resolver, a redirected domain resolves to a Control D proxy,
 * which carries the connection out of the restricted region. Returns the proxy URL.
 */
export function startDohBridge(dohUrl: string): Promise<string> {
  const cache = new Map<string, { address: string; until: number }>();
  const resolve = async (host: string): Promise<string> => {
    const known = cache.get(host);
    if (known && known.until > Date.now()) return known.address;
    const address = await resolveA(dohUrl, host);
    // A short cache keeps reconnects fast; the lookup itself also keeps this client known to the resolver.
    cache.set(host, { address, until: Date.now() + 60_000 });
    return address;
  };
  return startBridge((client, host, port) => {
    resolve(host).then(
      (address) => {
        const upstream = pair(client, connect(port, address));
        upstream.once("connect", () => established(client, upstream));
      },
      () => client.destroy(),
    );
  });
}

/** One A record through DNS over HTTPS (RFC 8484 wire format). */
async function resolveA(dohUrl: string, host: string): Promise<string> {
  const labels = host.split(".").flatMap((label) => [label.length, ...Buffer.from(label, "latin1")]);
  // Header: id 0, recursion desired, one question. Question: name, type A, class IN.
  const query = Uint8Array.of(0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, 0, 1, 0, 1);
  const response = await fetch(dohUrl, {
    method: "POST",
    headers: { "Content-Type": "application/dns-message", Accept: "application/dns-message" },
    body: query,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`DoH HTTP ${response.status}`);
  const message = new Uint8Array(await response.arrayBuffer());
  const skipName = (at: number): number => {
    while (message[at] !== 0) {
      if ((message[at] & 0xc0) === 0xc0) return at + 2; // compression pointer
      at += message[at] + 1;
    }
    return at + 1;
  };
  const answers = (message[6] << 8) | message[7];
  let at = skipName(12) + 4;
  for (let i = 0; i < answers; i++) {
    at = skipName(at);
    const type = (message[at] << 8) | message[at + 1];
    const length = (message[at + 8] << 8) | message[at + 9];
    if (type === 1 && length === 4) return message.subarray(at + 10, at + 14).join(".");
    at += 10 + length;
  }
  throw new Error(`DoH: нет адреса для ${host}`);
}
