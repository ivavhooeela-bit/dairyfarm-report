import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createBrowserContextManager } from "../lib/browser-context-manager.mjs";

function fakeContext() {
  const events = new EventEmitter();
  let connected = true;
  return {
    browser: () => ({ isConnected: () => connected }),
    once: events.once.bind(events),
    close: async () => {
      connected = false;
      events.emit("close");
    },
    disconnect: () => {
      connected = false;
      events.emit("close");
    }
  };
}

test("closed browser context is replaced automatically", async () => {
  const created = [];
  const manager = createBrowserContextManager(async () => {
    const context = fakeContext();
    created.push(context);
    return context;
  });
  const first = await manager.get();
  assert.equal(await manager.get(), first);
  first.disconnect();
  const second = await manager.get();
  assert.notEqual(second, first);
  assert.equal(created.length, 2);
  await manager.close();
});

test("parallel requests share one browser launch", async () => {
  let launches = 0;
  const manager = createBrowserContextManager(async () => {
    launches += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return fakeContext();
  });
  const [first, second] = await Promise.all([manager.get(), manager.get()]);
  assert.equal(first, second);
  assert.equal(launches, 1);
  await manager.close();
});
