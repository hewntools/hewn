// SPDX-License-Identifier: AGPL-3.0-or-later
// The few Node APIs the capability runtime uses under workerd's nodejs_compat.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
