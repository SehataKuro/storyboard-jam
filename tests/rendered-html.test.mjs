import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FPS,
  MIN_CUT_DURATION,
  formatFrameDuration,
  formatFramePosition,
  parseFrameDuration,
} from "../app/lib/types.ts";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the storyboard editor", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>STORYBOARD JAM/);
  assert.match(html, /絵コンテ描画キャンバス/);
  assert.match(html, /プロジェクト名/);
  assert.match(html, /連番＋AE/);
  assert.match(html, /60\+0/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("uses 24fps seconds+frames notation", () => {
  assert.equal(DEFAULT_FPS, 24);
  assert.equal(MIN_CUT_DURATION, 1 / 24);
  assert.equal(formatFrameDuration(0), "0+1");
  assert.equal(formatFrameDuration(1 / 24), "0+1");
  assert.equal(formatFrameDuration(23 / 24), "0+23");
  assert.equal(formatFrameDuration(1), "1+0");
  assert.equal(formatFramePosition(23 / 24), "0+23");
  assert.equal(formatFramePosition(1), "1+0");
  assert.equal(parseFrameDuration("0+1"), 1 / 24);
  assert.equal(parseFrameDuration("0+23"), 23 / 24);
  assert.equal(parseFrameDuration("1+0"), 1);
  assert.equal(parseFrameDuration("0+24"), null);
  assert.equal(parseFrameDuration("0+0"), null);
});
