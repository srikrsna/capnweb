---
"capnweb-validate": minor
---

Replace the `@validateRpc()` / `@skipRpcValidation()` decorators with comment
directives.

**Breaking:** the `validateRpc` and `skipRpcValidation` exports are removed.
Rewrite each decorator as a comment on the same declaration, then drop the
now-unused `capnweb-validate` imports:

| Before | After |
| ------ | ----- |
| `@validateRpc()` | `// @capnweb-validate` |
| `@validateRpc<T>()` | `// @capnweb-validate {T}` |
| `@skipRpcValidation()` | `// @capnweb-validate-ignore` |

```ts
// @capnweb-validate
export class Api extends RpcTarget {
  // @capnweb-validate-ignore
  unsafe(payload: unknown): unknown {
    return payload;
  }
}
```

Directives are read from JSDoc `/** ... */` comments as well as `//`.
