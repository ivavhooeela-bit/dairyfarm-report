function isUsable(context) {
  if (!context) return false;
  try {
    const browser = context.browser?.();
    return browser === null || browser === undefined || browser.isConnected?.() !== false;
  } catch {
    return false;
  }
}

export function createBrowserContextManager(launch) {
  let current = null;
  let launching = null;

  async function get() {
    if (isUsable(current)) return current;
    current = null;
    if (!launching) {
      launching = Promise.resolve()
        .then(launch)
        .then((created) => {
          current = created;
          created.once?.("close", () => {
            if (current === created) current = null;
          });
          return created;
        })
        .finally(() => {
          launching = null;
        });
    }
    return launching;
  }

  async function close() {
    const context = current;
    current = null;
    if (context) await context.close();
  }

  return { close, get };
}
