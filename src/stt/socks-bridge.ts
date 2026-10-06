import { connect, createServer, type Socket } from "node:net";

/**
 * Bun's WebSocket client speaks to HTTP proxies only, while the canonical office egress is
 * SOCKS5. This is a loopback HTTP CONNECT proxy that forwards every tunnel through SOCKS5.
 * Returns the proxy URL to hand to the WebSocket. No authentication on either side.
 */
export function startSocksBridge(socksUrl: string): Promise<string> {
  const socks = new URL(socksUrl);
  const server = createServer((client) => {
    client.once("data", (head) => {
      const target = head.toString("latin1").match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP/);
      if (!target) return client.destroy();
      tunnel(client, socks.hostname, Number(socks.port || 1080), target[1], Number(target[2]));
    });
    client.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

function tunnel(client: Socket, socksHost: string, socksPort: number, host: string, port: number): void {
  const upstream = connect(socksPort, socksHost);
  const fail = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", fail);
  client.on("error", fail);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());

  let step: "greeting" | "request" | "open" = "greeting";
  upstream.once("connect", () => upstream.write(Uint8Array.of(5, 1, 0))); // SOCKS5, one method: no auth
  upstream.on("data", function onData(chunk: Buffer) {
    if (step === "greeting") {
      if (chunk[0] !== 5 || chunk[1] !== 0) return fail();
      step = "request";
      // CONNECT to a domain name, so the name resolves at the far end of the tunnel.
      const name = Buffer.from(host, "latin1");
      upstream.write(Buffer.concat([Uint8Array.of(5, 1, 0, 3, name.length), name, Uint8Array.of(port >> 8, port & 0xff)]));
    } else if (step === "request") {
      if (chunk[0] !== 5 || chunk[1] !== 0) return fail();
      step = "open";
      upstream.off("data", onData);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(upstream);
      upstream.pipe(client);
    }
  });
}
