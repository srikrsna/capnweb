// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { ValidatedStub } from "./internal/core.js";
export type { ValidatedStub } from "./internal/core.js";

export function validateStub<TSurface>(stub: object): ValidatedStub<TSurface>;
export function validateStub(_stub: object): never {
  throw new Error(
    "capnweb-validate validateStub() was called before it was transformed. " +
      "Configure the capnweb-validate bundler plugin or run the capnweb-validate CLI."
  );
}
