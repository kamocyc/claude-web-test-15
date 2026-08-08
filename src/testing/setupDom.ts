/** jsdom setup for component tests. */
import '@testing-library/react';

// jsdom has no canvas implementation. Component tests never assert on pixels —
// canvas draw logic is covered by the recording-context tests in src/render —
// so a no-op 2D context is enough to keep components from throwing on mount.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function getContext(): null {
    return null;
  } as unknown as HTMLCanvasElement['getContext'];
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.matchMedia === 'undefined') {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
