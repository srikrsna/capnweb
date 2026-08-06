// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Comment directives that opt a class or method in or out of validation.
//
//   // @capnweb-validate                 enable
//   // @capnweb-validate {Cursor<string>}  enable with an explicit RPC surface
//   // @capnweb-validate-ignore          disable
//
// Directives are read from the leading comments of a class declaration or a
// class member, in both `//` and `/** */` form. They replace the old
// `@validateRpc()` / `@skipRpcValidation()` decorators, so no import or
// `experimentalDecorators` support is needed to annotate a service.

import type ts from "typescript";

// The directive tag, without the `-ignore` suffix.
export const DIRECTIVE_TAG = "@capnweb-validate";
export const IGNORE_DIRECTIVE_TAG = "@capnweb-validate-ignore";

export type Directive = {
  kind: "enable" | "disable";
  // Text between `{` and the matching `}` on an `enable` directive, i.e. the
  // explicit RPC surface type. Undefined when the directive had no braces.
  surfaceText?: string;
  // Absolute offset of the `@` in the file, for build errors and warnings.
  pos: number;
};

// `@capnweb-validate` / `@capnweb-validate-ignore` followed by a boundary, so
// `@capnweb-validated` or `@capnweb-validate-later` never match.
const DIRECTIVE_PATTERN = /@capnweb-validate(-ignore)?(?![\w-])/g;

// The directive on `node`'s leading comments, or null.
//
// Throws when a node carries more than one directive: silently honoring the
// first would be a validation gap the user cannot see.
export function readDirective(
  tsm: typeof ts,
  sf: ts.SourceFile,
  node: ts.Node
): Directive | null {
  let text = sf.text;
  let ranges = tsm.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  let found: Directive | null = null;
  for (let range of ranges) {
    // A comment trailing the previous line (`a() {} // @capnweb-validate`) is
    // also "leading" for whatever comes next. Honoring it there would silently
    // move a directive onto a declaration the user never annotated, so only
    // own-line comments count. A misplaced directive is then simply inert,
    // which fails toward validating rather than toward skipping.
    if (!startsItsLine(text, range.pos)) continue;
    for (let directive of parseCommentRange(sf, range)) {
      if (found) {
        throw new Error(
          `${formatLocation(sf, directive.pos)}: capnweb-validate: ` +
            `conflicting capnweb-validate directives on the same declaration. ` +
            `Use exactly one of \`${DIRECTIVE_TAG}\` or ` +
            `\`${IGNORE_DIRECTIVE_TAG}\`.`
        );
      }
      found = directive;
    }
  }
  return found;
}

// True when only whitespace precedes `pos` on its line.
function startsItsLine(text: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    let char = text[i]!;
    if (char === "\n" || char === "\r") return true;
    if (char !== " " && char !== "\t") return false;
  }
  return true;
}

// Every directive inside one comment range.
function parseCommentRange(
  sf: ts.SourceFile,
  range: ts.CommentRange
): Directive[] {
  let out: Directive[] = [];
  let body = sf.text.slice(range.pos, range.end);
  for (let match of body.matchAll(DIRECTIVE_PATTERN)) {
    let pos = range.pos + match.index;
    if (match[1]) {
      out.push({ kind: "disable", pos });
      continue;
    }
    let surfaceText = readSurfaceText(
      sf,
      body,
      match.index + match[0].length,
      pos
    );
    out.push({
      kind: "enable",
      ...(surfaceText === null ? {} : { surfaceText }),
      pos,
    });
  }
  return out;
}

// Read a `{...}` surface type immediately after the tag. Returns null when the
// directive has no braces, and throws when a `{` is never closed.
//
// Brace-matched rather than regex-matched so surface types that contain object
// literals (`{Record<string, {id: string}>}`) round-trip.
function readSurfaceText(
  sf: ts.SourceFile,
  body: string,
  from: number,
  tagPos: number
): string | null {
  let i = from;
  // Only horizontal space may separate the tag from its `{`; a newline means
  // the brace belongs to something else (or to the next JSDoc line).
  while (i < body.length && (body[i] === " " || body[i] === "\t")) i++;
  if (body[i] !== "{") return null;

  let depth = 0;
  for (let j = i; j < body.length; j++) {
    let char = body[j];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return stripCommentDecoration(body.slice(i + 1, j));
    } else if (char === "\n" && depth > 0) {
      // Keep the type on one line: a JSDoc continuation would drag `*` markers
      // and unrelated prose into the type text.
      break;
    }
  }
  throw new Error(
    `${formatLocation(sf, tagPos)}: capnweb-validate: unterminated \`{\` in ` +
      `\`${DIRECTIVE_TAG}\`. Put the RPC surface type on one line, e.g. ` +
      `\`${DIRECTIVE_TAG} {Cursor<string>}\`.`
  );
}

// Drop the block-comment terminator a `/* @capnweb-validate {T} */` leaves
// inside the captured text.
function stripCommentDecoration(text: string): string {
  return text.replace(/\*\/\s*$/, "").trim();
}

export function formatLocation(sf: ts.SourceFile, pos: number): string {
  let { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return `${sf.fileName}:${line + 1}:${character + 1}`;
}

const SURFACE_ALIAS_PREFIX = "type __capnweb_validate_surface = ";

// Parse the `{...}` payload of an enable directive into a `ts.TypeNode` the
// checker can resolve.
//
// The node is parsed in a throwaway file and then reparented onto `scope` (the
// annotated class). Name resolution walks `parent` pointers, so the type text
// resolves exactly where the comment sits: module imports, local aliases, and
// the class's own type parameters are all in scope, matching what the old
// `@validateRpc<T>()` type argument could see.
export function parseSurfaceTypeNode(
  tsm: typeof ts,
  sf: ts.SourceFile,
  scope: ts.Node,
  directive: Directive
): ts.TypeNode {
  let text = directive.surfaceText ?? "";
  let alias = tsm.createSourceFile(
    "__capnweb_validate_surface.ts",
    `${SURFACE_ALIAS_PREFIX}${text};`,
    tsm.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  let statement = alias.statements[0];
  let diagnostics =
    (alias as ts.SourceFile & { parseDiagnostics?: readonly unknown[] })
      .parseDiagnostics ?? [];
  if (
    alias.statements.length !== 1 ||
    !statement ||
    !tsm.isTypeAliasDeclaration(statement) ||
    diagnostics.length > 0
  ) {
    throw new Error(
      `${formatLocation(sf, directive.pos)}: capnweb-validate: ` +
        `\`{${text}}\` is not a valid TypeScript type. Write the RPC surface ` +
        `as a type expression, e.g. \`${DIRECTIVE_TAG} {Cursor<string>}\`.`
    );
  }
  // Reparent into the real tree so the checker resolves names lexically. The
  // node's own pos/end still point into the throwaway file, so callers must
  // report positions from `directive.pos` rather than from the node.
  (statement.type as ts.TypeNode & { parent: ts.Node }).parent = scope;
  return statement.type;
}
