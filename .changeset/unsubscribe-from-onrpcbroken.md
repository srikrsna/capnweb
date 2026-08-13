---
"capnweb": minor
---

`onRpcBroken()` now returns a callback that cancels the registration, so a listener can be removed without disposing the stub it was registered on. The returned callback is also `Disposable`, so it can be scoped with `using`:

```ts
using unsubscribe = stub.onRpcBroken(handleBreak);
```

Calling it twice, or after the connection has already broken, does nothing.
