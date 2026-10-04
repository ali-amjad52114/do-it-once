// Kernel browser adapter (agent B2). SERVER-ONLY: never import from client components.
import type { BrowserAdapter } from '@/lib/contracts';
import { KernelBrowserAdapter } from './adapter';

export { BrowserSessionGoneError, KernelBrowserAdapter } from './adapter';

const g = globalThis as typeof globalThis & { __doItOnceKernelAdapter?: KernelBrowserAdapter };

/** Process-wide singleton, kept on globalThis so Next dev hot reload doesn't leak CDP connections. */
export function getBrowserAdapter(): BrowserAdapter {
  return getKernelAdapter();
}

/** Same singleton with the concrete type (exposes closeAll() and the connection cache). */
export function getKernelAdapter(): KernelBrowserAdapter {
  g.__doItOnceKernelAdapter ??= new KernelBrowserAdapter();
  return g.__doItOnceKernelAdapter;
}
