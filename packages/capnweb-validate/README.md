# capnweb-validate

Build-time runtime validation for Cap'n Web and Workers RPC services.

`capnweb-validate` keeps TypeScript method signatures as the source of
truth. A bundler plugin or CLI generates validators from the resolved
TypeScript types and applies them to your service classes.

Validation is opt in. Mark a service class with a `// @capnweb-validate`
comment and its methods are checked.

## Install

```sh
npm install capnweb capnweb-validate
```

Workers RPC users can install `capnweb-validate` without installing `capnweb`.
The root package has no runtime dependency on `capnweb`; Cap'n Web-specific
helpers live under `capnweb-validate/capnweb` and internal transform outputs.

## Server Usage

```ts
import { newWorkersRpcResponse, RpcTarget } from "capnweb";

type User = { id: string; name: string };

// @capnweb-validate
export class Api extends RpcTarget {
  async authenticate(sessionToken: string): Promise<User> {
    // ...
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return newWorkersRpcResponse(request, new Api());
  },
};
```

Validation applies to class instances, so it works with Cap'n Web, Workers
`WorkerEntrypoint`, and Workers `DurableObject` services alike.

The RPC surface is the class's public string-named methods and RPC-readable
getters/properties, matching Cap'n Web dispatch. `implements SomeInterface` can
sharpen matching signatures, but it does not hide extra public class methods.
Keep local-only helpers private or symbol-named.

## Comment directives

| Comment | Where | Effect |
| ------- | ----- | ------ |
| `// @capnweb-validate` | class | Validate this class. |
| `// @capnweb-validate {Surface}` | class | Validate this class against `Surface` as the exact RPC surface. |
| `// @capnweb-validate-ignore` | class | Never validate this class, including where a marker call site would otherwise pick it up. |
| `// @capnweb-validate-ignore` | method | Pass this method through unvalidated. |
| `// @capnweb-validate` | method | Validate this method even though its class is not. |

Directives are read from a declaration's leading comments, so `//` and JSDoc
`/** ... */` both work:

```ts
/** Public API. @capnweb-validate-ignore */
export class Internal extends RpcTarget {
  // ...
}
```

An explicit `{Surface}` makes that type the RPC surface. Public class methods
outside it are rejected over RPC:

```ts
// @capnweb-validate {PublicApi}
export class Api extends RpcTarget implements PublicApi, InternalApi {
  // Only `PublicApi` members are callable over RPC.
}
```

A class-level ignore plus a method-level enable is per-method opt-in: the class
is still wrapped, but only the listed methods are checked.

```ts
// @capnweb-validate-ignore
export class Api extends RpcTarget {
  // @capnweb-validate
  authenticate(token: string): Promise<User> {
    // validated
  }

  legacy(payload: unknown): unknown {
    // not validated
  }
}
```

A directive naming a member that is not in the resolved RPC surface is a build
error rather than a silent no-op, so a typo or a stale annotation cannot leave
a boundary unchecked without you knowing.

## Generic service classes

One validator is emitted at the class declaration. If the class itself is
generic, the transform cannot specialize that validator for each later `new`
expression.

Use an explicit RPC surface when the type arguments are known at the class:

```ts
// @capnweb-validate {Gatekeeper<GmailSession, number, undefined>}
class GmailGatekeeper
  extends RpcTarget
  implements Gatekeeper<GmailSession, number, undefined> {
  // ...
}
```

The surface type is resolved in the class's own scope, so imports, local type
aliases, and the class's type parameters are all usable.

A generic implementation class needs no annotation. An unconstrained type
parameter defaults to `any` with a warning; a constrained parameter validates
against its constraint:

```ts
class ArrayCursor<T> extends RpcTarget implements Cursor<T> {
  // `T` defaults to `any` (warned). `<T extends Session>` would validate
  // those positions against `Session`.
}
```

Use `// @capnweb-validate {Cursor<string>}` to validate the `Cursor<string>`
surface, or `// @capnweb-validate {Cursor<any>}` to silence the warning while
keeping `Cursor` positions permissive.

## Client Usage

Client-side stub validation is explicit. Wrap a Cap'n Web client stub with
`validateStub<T>()` when the caller wants return values and pipelined calls
checked against a concrete surface:

```ts
import { newHttpBatchRpcSession } from "capnweb";
import { validateStub } from "capnweb-validate";

import type { Api } from "./worker";

export const api = validateStub<Api>(newHttpBatchRpcSession<Api>("/rpc"));
```

The same helper can wrap Workers RPC service stubs:

```ts
import { validateStub } from "capnweb-validate";

import type { Api } from "./worker";

export default {
  async fetch(_request: Request, env: { SERVICE: unknown }) {
    const api = validateStub<Api>(env.SERVICE as object);
    return Response.json(await api.status());
  },
};
```

`validateStub<T>()` validates resolved return values on the caller side. It does
not validate outgoing arguments; the receiver validates those on arrival. Normal
Cap'n Web client constructors are not rewritten automatically.

## Bundler Plugins

Use the adapter that matches your bundler:

```ts
import capnwebValidate from "capnweb-validate/vite";     // or
import capnwebValidate from "capnweb-validate/rollup";    // or
import capnwebValidate from "capnweb-validate/webpack";   // or
import capnwebValidate from "capnweb-validate/rspack";    // or
import capnwebValidate from "capnweb-validate/esbuild";   // or
import capnwebValidate from "capnweb-validate/farm";

export default {
  plugins: [capnwebValidate()],
};
```

The plugin transforms matching modules in memory; user source files are not
modified on disk.

Options:

- `tsconfig` — path to the `tsconfig.json` defining the program. Defaults to
  the nearest one above `cwd`.
- `include` / `exclude` — glob lists layered on top of the TypeScript root
  names.
- `cwd` — defaults to `process.cwd()`.
- `serverValidation` — `"throw"` (default) or `"warn"`.

## CLI

Wrangler does not expose a bundler plugin hook. For Wrangler, CI, or any flow
that needs transformed files on disk, run:

```sh
capnweb-validate build --out .capnweb-validate
```

Options:

- `--out <dir>` writes the transformed source tree. Required.
- `--tsconfig <path>` defaults to `./tsconfig.json`.
- `--cwd <dir>` defaults to `process.cwd()`.
- `--server-validation <throw|warn>` defaults to `throw`.

Point the downstream build tool at the generated entry under `--out`.

## Opting out per method

Use `// @capnweb-validate-ignore` when one RPC method should not get generated
argument or return validators:

```ts
import { RpcTarget } from "capnweb";

// @capnweb-validate
class Api extends RpcTarget {
  // @capnweb-validate-ignore
  unsafe(payload: unknown): unknown {
    return payload;
  }
}
```

The method still goes through capnweb normally. This only disables
capnweb-validate validation for that method.

## Validation Errors

Validation failures throw `TypeError`, so validation errors keep their standard
error type when they cross RPC boundaries. The message includes the failing path,
expected type, and actual type:

```ts
try {
  await api.authenticate(123 as never);
} catch (err) {
  if (err instanceof TypeError) {
    console.log(err.message);
  }
}
```

Where errors surface depends on which boundary failed:

| Boundary | Failure | How it surfaces |
| -------- | ------- | --------------- |
| Client stub | Bad resolved return | The returned promise rejects. |
| Server target | Bad incoming argument | The server throws and the caller observes an RPC rejection. |

## Current Type Coverage

The supported set matches capnweb's published wire format. Every type capnweb
guarantees can travel over RPC also has a precise build-time validator:

**Pass-by-value:**

- Primitives: `string`, `number`, `boolean`, `null`, `undefined`, `bigint`,
  `any`, `unknown`, plus string / number / boolean literal types. `any` and
  `unknown` use a permissive validator.
- Containers: arrays, tuples (validated by exact length and per-position
  element type), `Map<K, V>` / `ReadonlyMap<K, V>`, `Set<T>` /
  `ReadonlySet<T>`, plain object shapes, unions, `Record<K, T>` and index
  signatures (string and numeric keys both validate their value type, since
  object keys cross the wire as strings), and `Promise<T>` return values
  (unwrapped one level). Optional properties (`foo?: T`) widen to
  `T | undefined`, matching how the wire deserializes a missing key.
- Built-ins from the RPC-compatible runtime set: `Date`, `ArrayBuffer`,
  `DataView`, `RegExp`, `Uint8Array`, other typed arrays, `Error` and its
  standard subclasses (`EvalError`, `RangeError`, `ReferenceError`,
  `SyntaxError`, `TypeError`, `URIError`, `AggregateError`), `Blob`,
  `ReadableStream`, `WritableStream`, `Headers`, `Request`, `Response`.

Some host objects are checked by exact prototype to match the transport behavior;
`Error`, `ArrayBuffer`, `RegExp`, `DataView`, and typed arrays use `instanceof`.
`File` is rejected at build time because it is a common `Blob` subclass that does
not match the supported `Blob` validator.

**Pass-by-reference:**

- Plain functions (validated as `typeof === "function"`).
- `RpcStub<T>` and `RpcPromise<T>` by symbol name, and any user-defined class
  that extends `RpcTarget` (the resolver walks `getBaseTypes`).
- Workers RPC `Fetcher<T>` values and branded `RpcTarget` /
  `WorkerEntrypoint` capabilities. These are validated as pass-through stubs;
  lifecycle methods such as `fetch`, `queue`, and `tail` remain pass-through.

**Rejected types**: these cannot be validated as supported RPC values, and the
transform refuses to compile a service that uses them so the user finds out at
build time, not at the first RPC call:

| Type               | Build error hint                                           |
| ------------------ | ---------------------------------------------------------- |
| `WeakMap`          | `WeakMap` is not a supported RPC validation type.          |
| `WeakSet`          | `WeakSet` is not a supported RPC validation type.          |
| `SharedArrayBuffer`| `SharedArrayBuffer` is not a supported RPC validation type.|
| `File`             | Use a `Blob` or `Uint8Array`; `File` is not supported.     |

If a method signature contains a leaf the resolver cannot lower, such as a generic
type parameter with no inference source, an unsupported recursive corner, or a rejected
built-in nested inside an object, the transform fails at the call site with a
class-qualified list of every offending field. You fix them in one pass rather
than rebuilding once per field.

Recursive object and union shapes are emitted with lazy back-references. The
resolver also has a guardrail for pathological non-recursive nesting. If the
lowered type graph exceeds the internal resolution depth limit, it fails with
`type exceeds maximum resolution depth (64)`.

An overloaded method exposes several call signatures; validating against one
would reject valid calls to the others. Overloaded methods are passed through
unvalidated with a warning. Collapse the overloads into a single signature with
union parameters to validate the method, or `// @capnweb-validate-ignore` to
silence the warning.

## Schema Evolution

A validator built from one version of your types may receive values from a peer
built from another.

| Change                                | Result  |
| ------------------------------------- | ------- |
| Extra argument                        | Allowed |
| Extra object property                 | Allowed |
| Extra index-signature key             | Allowed |
| New optional parameter / property     | Allowed |
| Missing required parameter / property | Refused |
| Renamed or retyped member             | Refused |
| Changed tuple length, no rest element | Refused |
| New union member                      | Refused |
| New method                            | Refused |

Remove a required member by making it optional in one release and deleting it in
a later one.

Extra arguments to a validated method are dropped before it runs, but extra
object properties are forwarded to the implementation unvalidated. An index
signature is the exception: it validates every property outside the declared
ones.

Keep `strictNullChecks` on. Without it TypeScript erases `null` from your types
and the generated validator refuses a `null` that a peer built with it considers
valid.

## License

MIT.
