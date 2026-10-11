import { afterEach, describe, expect, it, mock } from "bun:test";
import { registerPwaServiceWorker } from "@zakki/web/client/pwa.ts";

describe("registerPwaServiceWorker", () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    if (originalWindow !== undefined) {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    } else {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it("window または navigator に serviceWorker が存在しない場合は何もしない", () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    expect(() => registerPwaServiceWorker()).not.toThrow();
  });

  it("load イベントで /sw.js の登録を試みる", async () => {
    const registerMock = mock(() =>
      Promise.resolve({
        update: mock(() => Promise.resolve()),
      } as unknown as ServiceWorkerRegistration),
    );
    const windowTarget = new EventTarget();
    (globalThis as unknown as { window: unknown }).window = windowTarget;

    Object.defineProperty(globalThis, "navigator", {
      value: {
        serviceWorker: {
          register: registerMock,
        },
      },
      configurable: true,
      writable: true,
    });

    registerPwaServiceWorker();

    // load イベントを発火
    windowTarget.dispatchEvent(new Event("load"));

    expect(registerMock).toHaveBeenCalledWith("/sw.js");
  });
});
