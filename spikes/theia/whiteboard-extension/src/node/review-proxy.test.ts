import assert from "node:assert/strict";
import { once } from "node:events";
import { type IncomingHttpHeaders, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  createReviewProxy,
  forwardedRequestHeaders,
  isCrossSiteWrite,
  isDiscardedPath,
  reviewProxyTarget,
} from "./review-proxy";

const server = "http://127.0.0.1:4100";

test("forwards review API paths and strips a caller-supplied token", () => {
  assert.equal(
    reviewProxyTarget("/reviews-api/abc/file?side=head&token=guess", server)
      ?.href,
    "http://127.0.0.1:4100/reviews-api/abc/file?side=head",
  );
});

test("forwards the review list at the API root", () => {
  assert.equal(
    reviewProxyTarget("/reviews-api?mode=all", server)?.href,
    "http://127.0.0.1:4100/reviews-api?mode=all",
  );
});

test("refuses paths that leave the review API", () => {
  assert.equal(reviewProxyTarget("/reviews-apix/secret", server), null);
  assert.equal(reviewProxyTarget("/health", server), null);
  assert.equal(reviewProxyTarget("/reviews-api/../health", server), null);
  assert.equal(reviewProxyTarget("/reviews-api/%2e%2e/health", server), null);
  assert.equal(reviewProxyTarget("//evil.example/reviews-api/x", server), null);
});

test("keeps canvas telemetry and bug reports inside the container", () => {
  assert.equal(isDiscardedPath("/reviews-api/abc/telemetry/tab"), true);
  assert.equal(isDiscardedPath("/reviews-api/abc/telemetry/bug-report"), true);
  assert.equal(isDiscardedPath("/reviews-api/abc/file"), false);
});

test("replaces browser credentials with the backend token", () => {
  const headers = forwardedRequestHeaders(
    {
      cookie: "session=1",
      authorization: "Bearer x",
      "x-review-token": "guess",
      "content-type": "application/json",
    },
    "secret",
  );

  assert.deepEqual(headers, {
    "content-type": "application/json",
    "x-review-token": "secret",
  });
});

test("refuses state-changing requests from another origin", () => {
  const sameSite: IncomingHttpHeaders = {
    host: "wb.example:3000",
    origin: "https://wb.example:3000",
  };

  assert.equal(isCrossSiteWrite("POST", sameSite), false);
  assert.equal(
    isCrossSiteWrite("POST", { ...sameSite, origin: "https://evil.example" }),
    true,
  );
  assert.equal(
    isCrossSiteWrite("GET", { ...sameSite, origin: "https://evil.example" }),
    false,
  );
  assert.equal(isCrossSiteWrite("POST", { host: "wb.example:3000" }), false);
  assert.equal(
    isCrossSiteWrite("POST", {
      host: "theia:3000",
      "x-forwarded-host": "wb.example",
      origin: "https://wb.example",
    }),
    false,
  );
});

test("streams responses and authenticates upstream", async (t) => {
  const seen: IncomingHttpHeaders[] = [];

  const upstream = createServer((incoming, outgoing) => {
    seen.push(incoming.headers);
    outgoing.writeHead(200, {
      "content-type": "application/x-ndjson",
      "access-control-allow-origin": "https://evil.example",
    });
    outgoing.write('{"n":1}\n');
    setTimeout(() => outgoing.end('{"n":2}\n'), 20);
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());

  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const proxy = createServer(
    createReviewProxy(async () => ({ url, token: "secret" })),
  );

  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => proxy.close());

  const reply = await new Promise<{
    body: string;
    headers: IncomingHttpHeaders;
  }>((resolve, reject) => {
    request(
      `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/reviews-api/abc/watch`,
      { headers: { cookie: "session=1" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ body, headers: response.headers }));
      },
    )
      .on("error", reject)
      .end();
  });

  assert.equal(reply.body, '{"n":1}\n{"n":2}\n');
  assert.equal(reply.headers["access-control-allow-origin"], undefined);
  assert.equal(seen[0]?.["x-review-token"], "secret");
  assert.equal(seen[0]?.cookie, undefined);
});
