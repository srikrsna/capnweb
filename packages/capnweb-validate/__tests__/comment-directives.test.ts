// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Validation is driven by comments, not decorators: `// @capnweb-validate`
// opts a class or method in, and `// @capnweb-validate-ignore` opts it back
// out. These cover directive parsing and the resulting per-class plan.

import { describe, expect, it } from "vitest";

import { v } from "../src/internal/core.js";
import type { TransformContextOptions } from "../src/transform/context.js";
import { transformModule } from "../src/transform/transform-module.js";
import {
  checkedMethod,
  createVirtualTransformContext,
  loadValidator,
  SHIM,
  transformError,
  transformFixture,
} from "./helpers.js";

const WORKERS_SHIM = `${SHIM}
declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    readonly __WORKER_ENTRYPOINT_BRAND: never;
    fetch?(request: Request): Response | Promise<Response>;
  }
  export class DurableObject<Env = unknown> {
    readonly __DURABLE_OBJECT_BRAND: never;
    fetch?(request: Request): Response | Promise<Response>;
  }
}`;

const WORKERS_IMPORTS = `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
`;

// Transform `body`, or return null when the module needs no rewrite.
function maybeTransform(
  body: string,
  opts: {
    shim?: string;
    imports?: string;
    transformOptions?: Partial<TransformContextOptions>;
  } = {}
): string | null {
  const imports =
    opts.imports ??
    `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
`;
  const code = imports + body;
  const ctx = createVirtualTransformContext({
    shim: opts.shim ?? SHIM,
    transformOptions: opts.transformOptions,
    worker: code,
  });
  try {
    const id = [...ctx.listSourceFiles()].find((file) =>
      file.endsWith("/worker.ts")
    );
    return transformModule(ctx, id!, code)?.code ?? null;
  } finally {
    ctx.dispose();
  }
}

describe("opt-in is required", () => {
  it("leaves an unannotated RpcTarget subclass alone", () => {
    // Extending an RPC base is not consent to rewrite the prototype.
    expect(
      maybeTransform(
        `export class Api extends RpcTarget {
  greet(name: string): string {
    return name;
  }
}`
      )
    ).toBeNull();
  });

  it("validates a class that opts in", () => {
    const code = maybeTransform(
      `// @capnweb-validate
export class Api extends RpcTarget {
  greet(name: string): string {
    return name;
  }
}`
    );
    expect(code).not.toBeNull();
    // Applied as a statement after the declaration, so the class stays a plain
    // exported declaration with its original name and hoisting.
    expect(code).toContain(
      "__cw.__validateRpcClass(__capnweb_validate_Api_server)(Api);"
    );
    const greet = checkedMethod(loadValidator(code!), "greet");
    expect(greet.args[0]).toBe(v.string);
    expect(greet.returns).toBe(v.string);
  });

  it("validates WorkerEntrypoint and DurableObject subclasses that opt in", () => {
    const code = maybeTransform(
      `// @capnweb-validate
export class Entry extends WorkerEntrypoint {
  a(x: string): Promise<string> {
    return null as any;
  }
}
// @capnweb-validate
export class Room extends DurableObject {
  b(x: number): Promise<number> {
    return null as any;
  }
}`,
      { shim: WORKERS_SHIM, imports: WORKERS_IMPORTS }
    );
    expect(code).toContain("__validateRpcClass(__capnweb_validate_Entry_server)(Entry);");
    expect(code).toContain("__validateRpcClass(__capnweb_validate_Room_server)(Room);");
    expect(
      checkedMethod(loadValidator(code!, "__capnweb_validate_Entry_server"), "a")
        .args[0]
    ).toBe(v.string);
    expect(
      checkedMethod(loadValidator(code!, "__capnweb_validate_Room_server"), "b")
        .args[0]
    ).toBe(v.number);
  });

  it("leaves a plain class that is not an RPC target alone", () => {
    expect(
      maybeTransform(
        `export class Helper {
  greet(name: string): string {
    return name;
  }
}`
      )
    ).toBeNull();
  });

  it("wraps an anonymous `export default class` as an expression", () => {
    const code = maybeTransform(
      `// @capnweb-validate
export default class extends RpcTarget {
  greet(name: string): string {
    return name;
  }
}`
    );
    expect(code).toContain(
      "export default __cw.__validateRpcClass(__capnweb_validate_default_server)(class extends RpcTarget {"
    );
  });
});

describe("class-level directives", () => {
  it("validates a non-RpcTarget class that opts in", () => {
    const code = maybeTransform(
      `// @capnweb-validate
export class Api {
  greet(name: string): string {
    return name;
  }
}`
    );
    expect(code).toContain("__validateRpcClass(");
    expect(checkedMethod(loadValidator(code!), "greet").args[0]).toBe(v.string);
  });

  it("accepts the JSDoc comment form", () => {
    const code = maybeTransform(
      `/** Public API. @capnweb-validate */
export class Api {
  greet(name: string): string {
    return name;
  }
}`
    );
    expect(code).toContain("__validateRpcClass(");
  });

  it("an ignored class is not wrapped and is not validated at a call site", () => {
    const code = maybeTransform(
      `// @capnweb-validate-ignore
class Api extends RpcTarget {
  greet(name: string): string {
    return name;
  }
}
export function handler(req: Request): Promise<Response> {
  return newWorkersRpcResponse(req, new Api());
}`
    );
    expect(code).not.toContain("__validateRpcClass(");
    // The marker call still wraps the target, but every method is pass-through:
    // an opt-out must not be defeated by the call site's own validator.
    expect(loadValidator(code!).methods.greet).toEqual({ unchecked: true });
  });

  it("rejects two conflicting directives on one declaration", () => {
    expect(
      transformError(
        `// @capnweb-validate
// @capnweb-validate-ignore
class Api extends RpcTarget {
  greet(name: string): string {
    return name;
  }
}`,
        { target: "new Api()" }
      )
    ).toContain("conflicting capnweb-validate directives");
  });

  it("ignores a directive trailing the previous line", () => {
    // The comment is "leading" trivia for `b` as far as TypeScript is
    // concerned. Honoring it there would silently unvalidate a method the
    // user never annotated, so it is inert instead.
    const code = maybeTransform(
      `// @capnweb-validate
export class Api extends RpcTarget {
  a(): string {
    return "";
  } // @capnweb-validate-ignore
  b(name: string): string {
    return name;
  }
}`
    );
    const validator = loadValidator(code!);
    expect(checkedMethod(validator, "a").returns).toBe(v.string);
    expect(checkedMethod(validator, "b").returns).toBe(v.string);
  });

  it("leaves an ambient `declare class` alone", () => {
    // There is no runtime prototype in this module to wrap.
    expect(
      maybeTransform(
        `declare class Api extends RpcTarget {
  greet(name: string): string;
}
export type { Api };`
      )
    ).toBeNull();
  });

  it("does not match a tag that only starts with the directive", () => {
    expect(
      maybeTransform(
        `// @capnweb-validate-ignore-later
export class Helper {
  greet(name: string): string {
    return name;
  }
}`
      )
    ).toBeNull();
  });
});

describe("method-level directives", () => {
  it("passes an ignored method through unvalidated", () => {
    const code = maybeTransform(
      `export class Api extends RpcTarget {
  greet(name: string): string {
    return name;
  }
  // @capnweb-validate-ignore
  unsafe(payload: unknown): unknown {
    return payload;
  }
}
export function handler(req: Request): Promise<Response> {
  return newWorkersRpcResponse(req, new Api());
}`
    );
    const validator = loadValidator(code!);
    expect(validator.methods.unsafe).toEqual({ unchecked: true });
    expect(checkedMethod(validator, "greet").returns).toBe(v.string);
  });

  it("an ignored method skips the build-time wire-type check", () => {
    // `WeakMap` is rejected for a validated method, so this only compiles
    // because the member opted out.
    const code = maybeTransform(
      `// @capnweb-validate
export class Api extends RpcTarget {
  // @capnweb-validate-ignore
  fn(m: WeakMap<object, number>): void {}
  greet(name: string): string {
    return name;
  }
}`
    );
    expect(loadValidator(code!).methods.fn).toEqual({ unchecked: true });
  });

  it("opts individual methods in when the class is ignored", () => {
    const code = maybeTransform(
      `// @capnweb-validate-ignore
export class Api extends RpcTarget {
  // @capnweb-validate
  checked(name: string): string {
    return name;
  }
  unchecked(payload: unknown): unknown {
    return payload;
  }
}`
    );
    // The class is still wrapped, but only the opted-in method is checked.
    expect(code).toContain("__validateRpcClass(");
    const validator = loadValidator(code!);
    expect(checkedMethod(validator, "checked").args[0]).toBe(v.string);
    expect(validator.methods.unchecked).toEqual({ unchecked: true });
  });

  it("rejects a member directive that names nothing in the RPC surface", () => {
    expect(
      transformError(
        `// @capnweb-validate
class Api extends RpcTarget {
  // @capnweb-validate-ignore
  private helper(): string {
    return "";
  }
  greet(name: string): string {
    return name;
  }
}`,
        { target: "new Api()" }
      )
    ).toContain("does not match a method in the resolved RPC surface");
  });

  it("rejects an explicit surface on a member", () => {
    expect(
      transformError(
        `class Api extends RpcTarget {
  // @capnweb-validate {string}
  greet(name: string): string {
    return name;
  }
}`,
        { target: "new Api()" }
      )
    ).toContain("belongs on the class");
  });
});

describe("explicit `{Surface}` directive", () => {
  it("uses the surface type as the exact RPC surface", () => {
    const { code } = transformFixture(
      `interface Sig {
  next(): Promise<string>;
}
// @capnweb-validate {Sig}
export class Api extends RpcTarget implements Sig {
  async next(): Promise<string> {
    return "";
  }
  async extra(x: number): Promise<number> {
    return x;
  }
}`
    );
    const validator = loadValidator(code);
    expect(Object.keys(validator.methods)).toEqual(["next"]);
  });

  it("resolves the surface in the class's lexical scope, including type params", () => {
    const { code, warns } = transformFixture(
      `interface Cursor<T> {
  next(): Promise<T>;
}
// @capnweb-validate {Cursor<string>}
export class Api<T> extends RpcTarget implements Cursor<T> {
  async next(): Promise<T> {
    return null as any;
  }
}`
    );
    expect(checkedMethod(loadValidator(code), "next").returns).toBe(v.string);
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("brace-matches a surface type containing an object literal", () => {
    const { code } = transformFixture(
      `interface Sig {
  next(): Promise<{ id: string }>;
}
// @capnweb-validate {Pick<Sig, "next">}
export class Api extends RpcTarget implements Sig {
  async next(): Promise<{ id: string }> {
    return { id: "" };
  }
}`
    );
    expect(Object.keys(loadValidator(code).methods)).toEqual(["next"]);
  });

  it("reports an unparsable surface type at the directive", () => {
    expect(
      transformError(
        `// @capnweb-validate {not a type!}
export class Api extends RpcTarget {
  greet(name: string): string {
    return name;
  }
}`
      )
    ).toContain("is not a valid TypeScript type");
  });
});

// `serverValidation` predates comment directives; these pin that it still
// reaches a validator applied by a class directive.
describe("serverValidation and class-wrapped validators", () => {
  const BODY = `// @capnweb-validate
export class Api extends RpcTarget {
  greet(name: string): string {
    return name;
  }
}`;

  it("defaults a class-wrapped validator to throw", () => {
    const code = maybeTransform(BODY);
    expect(loadValidator(code!).mode ?? "throw").toBe("throw");
  });

  it("propagates warn mode into a class-wrapped validator", () => {
    const code = maybeTransform(BODY, {
      transformOptions: { serverValidation: "warn" },
    });
    expect(loadValidator(code!).mode).toBe("warn");
  });
});
