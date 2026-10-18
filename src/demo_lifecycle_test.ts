import { test } from "bun:test";
import { deepStrictEqual as assertEquals, rejects as assertRejects } from "node:assert/strict";
import { startDemoServer } from "../demo/main.ts";
import { AnvilBaseFork } from "../demo/anvil.ts";
import { createDemoEnvironment, type DemoEnvironment } from "../demo/server.ts";

test("demo setup stops Anvil when KV acquisition fails", async () => {
  let started = 0;
  let stopped = 0;
  const anvil = {
    start() {
      started++;
      return Promise.resolve();
    },
    stop() {
      stopped++;
      return Promise.resolve();
    },
  } as unknown as AnvilBaseFork;

  await assertRejects(() =>
    createDemoEnvironment({
      anvil,
      openKv: () => Promise.reject(new Error("kv unavailable")),
    }),
  );
  assertEquals(started, 1);
  assertEquals(stopped, 1);
});

test("demo startup closes its environment when the HTTP listener cannot bind", async () => {
  let closed = 0;
  const environment = {
    handler: () => Promise.resolve(new Response()),
    close() {
      closed++;
      return Promise.resolve();
    },
  } as unknown as DemoEnvironment;
  const serve = (() => {
    throw new Error("port occupied");
  }) as typeof Bun.serve;

  await assertRejects(() => startDemoServer(environment, serve));
  assertEquals(closed, 1);
});
