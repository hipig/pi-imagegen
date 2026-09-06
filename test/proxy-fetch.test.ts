import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createProxyAwareFetch,
  proxyEnvironmentOptions,
} from "../src/proxy-fetch.ts";

test("proxy environment options support lowercase variables and HTTPS fallback", () => {
  assert.deepEqual(
    proxyEnvironmentOptions({
      http_proxy: " http://127.0.0.1:7890 ",
      no_proxy: " localhost,127.0.0.1 ",
    }),
    {
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "localhost,127.0.0.1",
    },
  );
  assert.equal(proxyEnvironmentOptions({}), undefined);
});

test("proxy-aware fetch routes HTTP requests through the configured proxy", async (t) => {
  let connectAuthority = "";
  let tunneledRequest = "";
  const proxy = createServer((request, response) => {
    tunneledRequest = request.url ?? "";
    response.writeHead(200, {
      "content-length": "7",
      "content-type": "text/plain",
    });
    response.end("proxied");
  });
  proxy.on("connect", (request, socket) => {
    connectAuthority = request.url ?? "";
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", (data) => {
      tunneledRequest = data.toString("utf8").split("\r\n", 1)[0] ?? "";
      socket.end(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/plain\r\n" +
          "Content-Length: 7\r\n" +
          "Connection: close\r\n\r\n" +
          "proxied",
      );
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    proxy.close((error) => error ? reject(error) : resolve());
  }));

  const address = proxy.address() as AddressInfo;
  const proxyFetch = createProxyAwareFetch({
    http_proxy: `http://127.0.0.1:${address.port}`,
    no_proxy: "",
  });
  t.after(() => proxyFetch.close());

  const response = await proxyFetch.fetch("http://upstream.invalid/probe");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "proxied");
  assert.ok(
    connectAuthority === "upstream.invalid:80" ||
      tunneledRequest.includes("http://upstream.invalid/probe") ||
      tunneledRequest.includes("GET /probe"),
  );
});
