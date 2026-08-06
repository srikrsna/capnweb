// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Per-module transform: resolve service types, emit validators, import the
// runtime, rewrite marker calls to runtime helpers, and wrap annotated service
// classes.

import ts from "typescript";

import {
  fileMatchesTransformFilters,
  type TransformContext,
  type TransformContextOptions,
} from "./context.js";
import {
  type Directive,
  DIRECTIVE_TAG,
  formatLocation,
  IGNORE_DIRECTIVE_TAG,
  parseSurfaceTypeNode,
  readDirective,
} from "./directives.js";
import { emitValidator } from "./emit.js";
import {
  collectPlatformMethodNames,
  collectUnsupported,
  type GenericFallback,
  isCapnwebValidateSymbol,
  isWorkerEntrypointType,
  type MethodShape,
  resolveServiceShape,
  type ServiceShape,
  type TypeShape,
  type UnsupportedPosition,
  type UnsupportedTypeIssue,
} from "./type-introspector.js";

export type TransformResult = {
  code: string;
};

type TextEdit = {
  start: number;
  end: number;
  text: string;
};

function applyTextEdits(code: string, edits: TextEdit[]): string {
  let ordered = edits
    .slice()
    .sort((a, b) => b.start - a.start || b.end - a.end);
  assertValidTextEdits(code, ordered);

  let out = code;
  for (let edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function assertValidTextEdits(code: string, ordered: TextEdit[]): void {
  for (let edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > code.length) {
      throw new Error(
        `capnweb-validate: invalid text edit [${edit.start},${edit.end})`
      );
    }
  }
  for (let i = 1; i < ordered.length; i++) {
    let right = ordered[i - 1]!;
    let left = ordered[i]!;
    if (left.start === right.start && left.end === right.end) {
      throw new Error(`capnweb-validate: duplicate text edit at ${left.start}`);
    }
    if (left.end > right.start) {
      throw new Error(
        `capnweb-validate: overlapping text edits ` +
          `[${left.start},${left.end}) and [${right.start},${right.end})`
      );
    }
  }
}

const PACKAGE_NAME = "capnweb-validate";
const CAPNWEB_MARKER_PACKAGE_NAME = "capnweb-validate/capnweb";
const RUNTIME_NAMESPACE = "__cw";

const CORE_RUNTIME_IMPORT = `import * as ${RUNTIME_NAMESPACE} from "${PACKAGE_NAME}/internal/core";\n`;
const CAPNWEB_RUNTIME_IMPORT = `import * as ${RUNTIME_NAMESPACE} from "${PACKAGE_NAME}/internal/capnweb";\n`;
const CORE_RUNTIME_NAMESPACE = "__cvcore";
const CORE_RUNTIME_EXTRA_IMPORT = `import * as ${CORE_RUNTIME_NAMESPACE} from "${PACKAGE_NAME}/internal/core";\n`;

// Exported so marker-coverage.test.ts can assert this stays in sync with capnweb's actual RPC entry points.
export const MARKERS: Record<
  string,
  {
    side: "server" | "client";
    helper: string;
    targetArgIndex: number;
    form: "call" | "new";
  }
> = {
  newWorkersRpcResponse: {
    side: "server",
    form: "call",
    helper: "__newWorkersRpcResponseWithValidation",
    targetArgIndex: 1,
  },
  newWorkersWebSocketRpcResponse: {
    side: "server",
    form: "call",
    helper: "__newWorkersWebSocketRpcResponseWithValidation",
    targetArgIndex: 1,
  },
  newHttpBatchRpcResponse: {
    side: "server",
    form: "call",
    helper: "__newHttpBatchRpcResponseWithValidation",
    targetArgIndex: 1,
  },
  nodeHttpBatchRpcResponse: {
    side: "server",
    form: "call",
    helper: "__nodeHttpBatchRpcResponseWithValidation",
    targetArgIndex: 2,
  },
  validateStub: {
    side: "client",
    form: "call",
    helper: "__validateStub",
    targetArgIndex: 0,
  },
};

export function transformModule(
  context: TransformContext,
  id: string,
  code: string
): TransformResult | null {
  if (!code.includes(PACKAGE_NAME)) {
    return null;
  }
  if (!fileMatchesTransformFilters(id, context.options)) return null;

  let sourceFile = context.getSourceFile(id);
  if (!sourceFile) return null;
  let checker = context.getChecker();

  let { bindings: markerBindings, namespaces: markerNamespaces } =
    collectMarkerBindings(sourceFile);

  // One index for the whole module: a member's directives must mean the same
  // thing whether the class is reached through its own declaration or through
  // a `newWorkersRpcResponse(req, new Api())` call site. Otherwise the call
  // site would emit a validator that re-checks a method the user opted out of.
  let plans = new ClassPlanIndex(checker, context.options);

  let callSites = collectMarkerCallSites(
    sourceFile,
    markerBindings,
    markerNamespaces,
    checker,
    plans
  );
  let classSites = collectClassSites(sourceFile, checker, plans);

  if (callSites.length === 0 && classSites.length === 0) return null;

  let dedup = new ValidatorDedup();
  for (let site of callSites) {
    site.bindingName = dedup.bind(site.shape, site.side);
  }
  for (let site of classSites) {
    site.bindingName = dedup.bind(site.shape, "server");
  }

  let serverMode = context.options.serverValidation ?? "throw";

  let edits: TextEdit[] = [];
  let capnwebCallSites = callSites.filter(
    (site) => site.marker.side === "server"
  );
  let coreCallSites = callSites.filter((site) => site.marker.side === "client");
  let needsCapnwebRuntime = capnwebCallSites.length > 0;
  let needsCoreExtraRuntime = needsCapnwebRuntime && coreCallSites.length > 0;
  let prelude = needsCapnwebRuntime
    ? CAPNWEB_RUNTIME_IMPORT
    : CORE_RUNTIME_IMPORT;
  if (needsCoreExtraRuntime) prelude += CORE_RUNTIME_EXTRA_IMPORT;
  for (let entry of dedup.emitOrder()) {
    let mode = entry.side === "client" ? "throw" : serverMode;
    prelude +=
      emitValidator(entry.bindingName, entry.shape, mode, entry.side) + "\n";
  }
  edits.push({ start: 0, end: 0, text: prelude });

  for (let cs of callSites) {
    let callee = cs.call.expression;
    let runtimeNamespace = cs.marker.side === "client"
      ? needsCapnwebRuntime
        ? CORE_RUNTIME_NAMESPACE
        : RUNTIME_NAMESPACE
      : RUNTIME_NAMESPACE;
    let headStart =
      cs.marker.form === "new"
        ? cs.call.getStart(sourceFile)
        : callee.getStart(sourceFile);
    edits.push({
      start: headStart,
      end: callee.getEnd(),
      text: `${runtimeNamespace}.${cs.marker.helper}`,
    });
    let args = cs.call.arguments;
    if (args && args.length > 0) {
      // Insert after the last arg, not before `)`, so a trailing comma does
      // not produce `f(a, b,, __v)`.
      let pos = args[args.length - 1]!.getEnd();
      edits.push({ start: pos, end: pos, text: `, ${cs.bindingName!}` });
    } else {
      let closeParenPos = cs.call.getEnd() - 1;
      edits.push({
        start: closeParenPos,
        end: closeParenPos,
        text: `${cs.bindingName!}`,
      });
    }
  }

  for (let site of classSites) {
    edits.push(...classWrapEdits(sourceFile, site));
  }

  return { code: applyTextEdits(code, edits) };
}

// Apply the validator to an annotated class.
//
// `__validateRpcClass` wraps the prototype in place and returns the class, so
// a statement right after the declaration is enough. That keeps the class a
// plain declaration: its binding, `export` form, name, and hoisting are all
// unchanged, and nothing depends on decorator support in the user's tsconfig.
function classWrapEdits(sf: ts.SourceFile, site: ClassSite): TextEdit[] {
  let { cls, bindingName } = site;
  let apply = `${RUNTIME_NAMESPACE}.__validateRpcClass(${bindingName!})`;
  let end = cls.getEnd();
  if (cls.name) {
    return [{ start: end, end, text: `\n${apply}(${cls.name.text});` }];
  }
  // `export default class { ... }` has no binding to reference afterwards, so
  // the wrapper has to take the class expression itself.
  let classKeyword = cls
    .getChildren(sf)
    .find((child) => child.kind === ts.SyntaxKind.ClassKeyword);
  // Only a default export may omit the class name, and the rewrite below
  // depends on there being an `export default` prefix to replace.
  if (!classKeyword || classKeyword.getStart(sf) === cls.getStart(sf)) {
    throw buildErrorAt(
      sf,
      site.pos,
      `capnweb-validate: cannot apply validation to an unnamed class. ` +
        `Give the class a name.`
    );
  }
  return [
    {
      start: cls.getStart(sf),
      end: classKeyword.getStart(sf),
      text: `export default ${apply}(`,
    },
    { start: end, end, text: `);` },
  ];
}

type MarkerBinding = {
  localName: string;
  markerName: keyof typeof MARKERS;
};

type MarkerImports = {
  /** Named imports: `{ validateStub }` -> `validateStub(...)`. */
  bindings: Map<string, MarkerBinding>;
  /** Namespace import locals: `* as ns` -> `ns.validateStub(...)`. */
  namespaces: Set<string>;
};

// Catch namespace call sites (`ns.marker(...)`) too; missing them silently
// skips validation, which is worse than a build error.
function collectMarkerBindings(sf: ts.SourceFile): MarkerImports {
  let bindings = new Map<string, MarkerBinding>();
  let namespaces = new Set<string>();
  for (let stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    let mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (mod.text !== CAPNWEB_MARKER_PACKAGE_NAME && mod.text !== PACKAGE_NAME)
      continue;
    let named = stmt.importClause?.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      namespaces.add(named.name.text);
    } else if (ts.isNamedImports(named)) {
      for (let spec of named.elements) {
        let imported = (spec.propertyName ?? spec.name).text;
        if (!(imported in MARKERS)) continue;
        bindings.set(spec.name.text, {
          localName: spec.name.text,
          markerName: imported as keyof typeof MARKERS,
        });
      }
    }
  }
  return { bindings, namespaces };
}

type CallSite = {
  call: ts.CallExpression | ts.NewExpression;
  marker: (typeof MARKERS)[keyof typeof MARKERS];
  side: "server" | "client";
  shape: ServiceShape;
  bindingName?: string;
};

type ClassSite = {
  cls: ts.ClassDeclaration;
  // Offset diagnostics about this class point at (its directive, or the class).
  pos: number;
  shape: ServiceShape;
  bindingName?: string;
};

// A call, or a `new` with an argument list. A bare `new Foo` without `()` is
// never a marker call, so it is excluded.
function isCallLike(
  node: ts.Node
): node is ts.CallExpression | ts.NewExpression {
  return (
    ts.isCallExpression(node) ||
    (ts.isNewExpression(node) && node.arguments !== undefined)
  );
}

function collectMarkerCallSites(
  sf: ts.SourceFile,
  bindings: Map<string, MarkerBinding>,
  namespaces: Set<string>,
  checker: ts.TypeChecker,
  plans: ClassPlanIndex
): CallSite[] {
  let out: CallSite[] = [];
  function visit(node: ts.Node): void {
    if (isCallLike(node)) {
      let resolved = resolveMarkerCallee(
        node.expression,
        bindings,
        namespaces,
        checker
      );
      if (resolved) {
        pushCallSite(
          out,
          sf,
          node,
          resolved.marker,
          resolved.localName,
          checker,
          plans
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

/** Map a callee to its marker, via named (`marker(...)`) or namespace (`ns.marker(...)`) import. */
function resolveMarkerCallee(
  callee: ts.Expression,
  bindings: Map<string, MarkerBinding>,
  namespaces: Set<string>,
  checker: ts.TypeChecker
): { marker: (typeof MARKERS)[keyof typeof MARKERS]; localName: string } | null {
  if (ts.isIdentifier(callee)) {
    let binding = bindings.get(callee.text);
    // Confirm the name resolves to the imported marker, not a local that shadows it.
    if (
      !binding ||
      !resolvesToMarker(checker, callee, binding.markerName)
    ) {
      return null;
    }
    return { marker: MARKERS[binding.markerName], localName: binding.localName };
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    namespaces.has(callee.expression.text) &&
    callee.name.text in MARKERS
  ) {
    let markerName = callee.name.text as keyof typeof MARKERS;
    if (!resolvesToMarker(checker, callee.name, markerName)) return null;
    return {
      marker: MARKERS[markerName],
      localName: `${callee.expression.text}.${callee.name.text}`,
    };
  }
  return null;
}

// True when the callee resolves to the capnweb-validate marker export, so a local
// binding that shadows the imported name is not rewritten as a marker call.
function resolvesToMarker(
  checker: ts.TypeChecker,
  node: ts.Node,
  markerName: string
): boolean {
  let sym = checker.getSymbolAtLocation(node);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym?.getName() === markerName && isCapnwebValidateSymbol(sym);
}

function pushCallSite(
  out: CallSite[],
  sf: ts.SourceFile,
  call: ts.CallExpression | ts.NewExpression,
  marker: (typeof MARKERS)[keyof typeof MARKERS],
  localName: string,
  checker: ts.TypeChecker,
  plans: ClassPlanIndex
): void {
  let expected = marker.form;
  let actual: "call" | "new" = ts.isNewExpression(call) ? "new" : "call";
  if (expected !== actual) return;
  let shape = resolveCallSiteShape(call, marker, checker, plans);
  if (shape === null) {
    throw buildError(
      sf,
      call,
      `capnweb-validate: could not resolve a concrete service type for ` +
        `\`${localName}(...)\`. Annotate the call with a specific RPC service type.`
    );
  }
  rejectUnsupported(sf, call.getStart(sf), shape);
  out.push({ call, marker, side: marker.side, shape });
}

// Every class in the module that should get a generated validator.
//
// A class is included when a `// @capnweb-validate` comment opts it in, or when
// individual members do while the class itself is ignored.
function collectClassSites(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  plans: ClassPlanIndex
): ClassSite[] {
  let out: ClassSite[] = [];
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      let plan = plans.forClass(node);
      if (plan?.wrap) {
        let shape = resolveAnnotatedClassShape(sf, node, plan, checker, plans);
        rejectUnsupported(sf, plan.pos, shape);
        out.push({ cls: node, pos: plan.pos, shape });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

type ClassPlan = {
  // Offset diagnostics point at: the class directive, or the class itself.
  pos: number;
  // The class-level directive, when the user wrote one.
  directive: Directive | null;
  // Own members explicitly opted out, by name, with the directive offset.
  disabled: Map<string, number>;
  // Own members explicitly opted in, by name, with the directive offset.
  enabled: Map<string, number>;
  // What happens to a member that carries no directive of its own.
  memberDefault: "validate" | "skip";
  // Whether the class declaration itself gets a `__validateRpcClass` call.
  wrap: boolean;
};

// Per-module cache of each class's validation plan, and the single source of
// truth for "is this member validated?".
class ClassPlanIndex {
  #checker: ts.TypeChecker;
  #plans = new Map<ts.ClassDeclaration, ClassPlan | null>();

  constructor(
    checker: ts.TypeChecker,
    options: TransformContextOptions
  ) {
    this.#checker = checker;
  }

  forClass(cls: ts.ClassDeclaration): ClassPlan | null {
    let cached = this.#plans.get(cls);
    if (cached !== undefined) return cached;
    let plan = planClassValidation(cls);
    this.#plans.set(cls, plan);
    return plan;
  }

  // True when `prop` is declared on a class whose plan opts it out. Resolving
  // through the declaration keeps this scoped: a same-named method on an
  // unrelated nested service type is unaffected.
  isSkippedMember = (prop: ts.Symbol): boolean => {
    for (let decl of prop.declarations ?? []) {
      let parent = decl.parent as ts.Node | undefined;
      if (!parent || !ts.isClassDeclaration(parent)) continue;
      let plan = this.forClass(parent);
      if (plan && isSkippedMemberName(plan, prop.getName())) return true;
    }
    return false;
  };
}

// Decide whether `cls` is wrapped and how its members default. Returns null
// when no directive applies to the class or any of its members, which leaves
// member resolution exactly as it was.
//
// A class that is off but has explicitly enabled members flips into opt-in
// mode: it is wrapped, but only the enabled members are checked.
function planClassValidation(cls: ts.ClassDeclaration): ClassPlan | null {
  // A `declare class` (or a class inside `declare module`) has no runtime
  // prototype in this module to wrap, and its members belong to whatever
  // implements it elsewhere.
  if (isAmbientDeclaration(cls)) return null;
  let sf = cls.getSourceFile();
  let directive = readDirective(ts, sf, cls);
  let enabled = new Map<string, number>();
  let disabled = new Map<string, number>();
  for (let member of cls.members) {
    let memberDirective = readDirective(ts, sf, member);
    if (!memberDirective) continue;
    let name = member.name ? memberName(member.name) : null;
    if (!name) {
      throw buildErrorAt(
        sf,
        memberDirective.pos,
        `capnweb-validate: a \`${DIRECTIVE_TAG}\` comment must be attached to ` +
          `a string-named class member. Private, computed, and symbol-named ` +
          `members are not part of the RPC surface.`
      );
    }
    if (memberDirective.surfaceText !== undefined) {
      throw buildErrorAt(
        sf,
        memberDirective.pos,
        `capnweb-validate: an explicit RPC surface \`{...}\` belongs on the ` +
          `class, not on member \`${name}\`.`
      );
    }
    if (memberDirective.kind === "enable") {
      enabled.set(name, memberDirective.pos);
    } else {
      disabled.set(name, memberDirective.pos);
    }
  }

  let pos = directive ? directive.pos : cls.getStart(sf);
  let base = { pos, directive, disabled, enabled };
  // Strictly opt in: a class is validated only when a directive says so.
  if (directive?.kind === "enable") {
    return { ...base, memberDefault: "validate", wrap: true };
  }
  if (enabled.size > 0) {
    // Class is off, but individual members opted in.
    return { ...base, memberDefault: "skip", wrap: true };
  }
  if (directive) {
    // Explicitly ignored. Nothing on this class is validated, including when a
    // marker call site resolves an instance of it.
    return { ...base, memberDefault: "skip", wrap: false };
  }
  if (disabled.size > 0) {
    // Not annotated as a service, but individual members opted out. Honored so
    // a marker call site does not validate them either.
    return { ...base, memberDefault: "validate", wrap: false };
  }
  return null;
}

function resolveAnnotatedClassShape(
  sf: ts.SourceFile,
  cls: ts.ClassDeclaration,
  plan: ClassPlan,
  checker: ts.TypeChecker,
  plans: ClassPlanIndex
): ServiceShape {
  let classType = getClassInstanceType(cls, checker);
  let surfaceNode =
    plan.directive && plan.directive.surfaceText !== undefined
      ? parseSurfaceTypeNode(ts, sf, cls, plan.directive)
      : null;
  if (surfaceNode && typeNodeContainsAny(surfaceNode)) {
    warnSurfaceAny(sf, plan.pos);
  }
  let signatureType = surfaceNode
    ? checker.getTypeFromTypeNode(surfaceNode)
    : getSingleImplementedType(cls, checker);
  if (signatureType && isTooGeneric(signatureType)) {
    throw unresolvableClassError(sf, cls, plan.pos);
  }
  // Generic class with no explicit surface: default free params to `any` and
  // record it so we can warn those positions are not validated. Constrained
  // params still resolve against their constraint.
  let generic: GenericFallback = {
    mode:
      !surfaceNode && (cls.typeParameters?.length ?? 0) > 0 ? "any" : "error",
    used: false,
  };
  let resolved = resolveServiceShape(ts, checker, classType, {
    generic,
    signatureType,
    signatureMode: surfaceNode ? "exact" : "sharpen",
    isSkippedMember: plans.isSkippedMember,
  });
  if (resolved === null) throw unresolvableClassError(sf, cls, plan.pos);
  if (generic.used) warnGenericDefaultedToAny(sf, cls, plan.pos);

  let shape = cloneServiceShape(resolved);
  rejectDirectivesOutsideSurface(sf, cls, shape, plan);
  // Re-apply by name so members inherited from an unvalidated base obey this
  // class's plan too; `isSkippedMember` only sees declarations, which for an
  // inherited method live on the base class.
  shape = applySkippedMethods(shape, (name) => isSkippedMemberName(plan, name));
  if (isWorkerEntrypointType(checker, classType)) {
    shape.targetKind = "workerEntrypoint";
  }
  return applyPlatformPassthrough(checker, classType, shape);
}

function isAmbientDeclaration(node: ts.Declaration): boolean {
  if (hasDeclareModifier(node)) return true;
  // A class inside `declare module "x" { ... }` carries no `declare` modifier
  // of its own, so check the enclosing module blocks too.
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isModuleDeclaration(parent) && hasDeclareModifier(parent)) return true;
  }
  return false;
}

function hasDeclareModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword
    )
  );
}

function isSkippedMemberName(plan: ClassPlan, name: string): boolean {
  if (plan.disabled.has(name)) return true;
  return plan.memberDefault === "skip" && !plan.enabled.has(name);
}

function unresolvableClassError(
  sf: ts.SourceFile,
  cls: ts.ClassDeclaration,
  pos: number
): Error {
  return buildErrorAt(
    sf,
    pos,
    `capnweb-validate: could not resolve a concrete RPC surface for ` +
      `\`${cls.name?.text ?? "the annotated class"}\`.`
  );
}

function typeNodeContainsAny(node: ts.TypeNode): boolean {
  let found = false;
  function visit(current: ts.Node): void {
    if (found) return;
    if (current.kind === ts.SyntaxKind.AnyKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function warnGenericDefaultedToAny(
  sf: ts.SourceFile,
  cls: ts.ClassDeclaration,
  pos: number
): void {
  let name = cls.name?.text ?? "class";
  console.warn(
    `${formatLocation(sf, pos)}: capnweb-validate: ` +
      `\`${name}\` is generic; unconstrained type parameters default to ` +
      `\`any\` and are not runtime-validated. Give an explicit RPC surface ` +
      `(e.g. \`// ${DIRECTIVE_TAG} {${name}<string>}\`) or constrain the ` +
      `parameter (\`<T extends ...>\`) to validate those positions.`
  );
}

function warnSurfaceAny(sf: ts.SourceFile, pos: number): void {
  console.warn(
    `${formatLocation(sf, pos)}: capnweb-validate: ` +
      `the \`${DIRECTIVE_TAG}\` surface type contains \`any\`; generic ` +
      `content at that position is not runtime-validated. Use a concrete ` +
      `surface type if that boundary needs full validation.`
  );
}

function getSingleImplementedType(
  cls: ts.ClassDeclaration,
  checker: ts.TypeChecker
): ts.Type | null {
  let impls: ts.ExpressionWithTypeArguments[] = [];
  for (let clause of cls.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ImplementsKeyword)
      impls.push(...clause.types);
  }
  // A single implemented interface can provide more precise signatures for
  // matching class methods, but it is not the runtime method allowlist.
  if (impls.length === 1) return checker.getTypeAtLocation(impls[0]!);
  return null;
}

function getClassInstanceType(
  cls: ts.ClassDeclaration,
  checker: ts.TypeChecker
): ts.Type {
  let name = cls.name;
  if (name) {
    let sym = checker.getSymbolAtLocation(name);
    if (sym) return checker.getDeclaredTypeOfSymbol(sym);
  }
  return checker.getTypeAtLocation(cls);
}

function cloneServiceShape(shape: ServiceShape): ServiceShape {
  return {
    ...shape,
    methods: shape.methods.map((method) =>
      method.skipValidation
        ? { ...method }
        : {
            ...method,
            params: method.params.slice(),
          }
    ),
  };
}

// A member directive that names something outside the resolved RPC surface is
// almost always a typo or a stale annotation, and silently ignoring it would
// leave the user believing a method is (or is not) validated.
function rejectDirectivesOutsideSurface(
  sf: ts.SourceFile,
  cls: ts.ClassDeclaration,
  shape: ServiceShape,
  plan: ClassPlan
): void {
  let surfaceMethods = new Set(shape.methods.map((method) => method.name));
  let className = cls.name?.text ?? "<anonymous>";
  let check = (name: string, pos: number, tag: string): void => {
    if (surfaceMethods.has(name)) return;
    throw buildErrorAt(
      sf,
      pos,
      `capnweb-validate: \`${tag}\` on ${className}.${name} does not match a ` +
        `method in the resolved RPC surface ${shape.name}. Member directives ` +
        `only apply to methods in the RPC surface.`
    );
  };
  for (let [name, pos] of plan.disabled) check(name, pos, IGNORE_DIRECTIVE_TAG);
  for (let [name, pos] of plan.enabled) check(name, pos, DIRECTIVE_TAG);
}

function applySkippedMethods(
  shape: ServiceShape,
  isSkipped: (name: string) => boolean
): ServiceShape {
  return {
    ...shape,
    methods: shape.methods.map((method): MethodShape =>
      isSkipped(method.name)
        ? { name: method.name, skipValidation: true }
        : method
    ),
  };
}

function memberName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function rejectUnsupported(
  sf: ts.SourceFile,
  pos: number,
  shape: ServiceShape
): void {
  let bad = collectUnsupported(shape);
  if (bad.length === 0) return;
  if (bad.length === 1) {
    throw buildErrorAt(
      sf,
      pos,
      `capnweb-validate: ${formatUnsupportedIssue(bad[0]!)}`
    );
  }
  let detail = bad.map((b) => `  - ${formatUnsupportedIssue(b)}`).join("\n");
  throw buildErrorAt(
    sf,
    pos,
    `capnweb-validate: \`${shape.name}\` references types that ` +
      `capnweb-validate cannot validate:\n${detail}`
  );
}

function formatUnsupportedIssue(issue: UnsupportedTypeIssue): string {
  let location = formatUnsupportedLocation(issue);
  if (!issue.typeExpr) return `${location}: ${issue.reason}`;
  let message =
    `${location} ${formatUnsupportedVerb(issue.position)} ` +
    `${issue.typeExpr}, which is ${issue.reason}.`;
  if (issue.fixHint) message += ` ${issue.fixHint}`;
  return message;
}

function formatUnsupportedLocation(issue: UnsupportedTypeIssue): string {
  let base = `${issue.serviceName}.${issue.methodName}`;
  let { position } = issue;
  switch (position.kind) {
    case "arg":
      return position.suffix
        ? `${base} argument ${position.index} ${position.suffix}`
        : `${base} argument ${position.index}`;
    case "rest":
      return position.suffix
        ? `${base} rest argument ${position.suffix}`
        : `${base} rest argument`;
    case "return":
      return position.suffix ? `${base} return ${position.suffix}` : `${base}`;
  }
}

function formatUnsupportedVerb(
  position: UnsupportedPosition
): "is" | "returns" {
  return position.kind === "return" && position.suffix === ""
    ? "returns"
    : "is";
}

function resolveCallSiteShape(
  call: ts.CallExpression | ts.NewExpression,
  marker: (typeof MARKERS)[keyof typeof MARKERS],
  checker: ts.TypeChecker,
  plans: ClassPlanIndex
): ServiceShape | null {
  let type: ts.Type;
  if (marker.side === "client") {
    let explicit = getExplicitTypeArgument(call, checker);
    if (explicit) {
      type = unwrapRpcStub(checker, explicit);
    } else {
      let arg = call.arguments?.[marker.targetArgIndex];
      if (!arg) return null;
      let unwrapped = unwrapRpcStub(checker, checker.getTypeAtLocation(arg));
      if (isTooGeneric(unwrapped)) return null;
      type = unwrapped;
    }
  } else {
    let arg = call.arguments?.[marker.targetArgIndex];
    if (!arg) return null;
    type = checker.getTypeAtLocation(arg);
  }
  if (isTooGeneric(type)) return null;
  let shape = resolveServiceShape(ts, checker, type, {
    isSkippedMember: plans.isSkippedMember,
  });
  return shape && applyPlatformPassthrough(checker, type, shape);
}

function applyPlatformPassthrough(
  checker: ts.TypeChecker,
  type: ts.Type,
  shape: ServiceShape
): ServiceShape {
  // Pass-through names come from the concrete target type, not the
  // possibly-narrowed resolved surface, since the proxy wraps the instance.
  let platform = collectPlatformMethodNames(checker, type);
  if (platform.length === 0) return { ...shape, passthrough: undefined };
  let platformMethods = new Set(platform);
  return {
    ...shape,
    methods: shape.methods.filter((method) => !platformMethods.has(method.name)),
    passthrough: platform,
  };
}

function getExplicitTypeArgument(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker
): ts.Type | null {
  let arg = call.typeArguments?.[0];
  return arg ? checker.getTypeFromTypeNode(arg) : null;
}

function unwrapRpcStub(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  let sym = type.getSymbol();
  if (sym && (sym.getName() === "RpcStub" || sym.getName() === "RpcPromise")) {
    let args = checker.getTypeArguments(type as ts.TypeReference);
    if (args.length === 1) return args[0]!;
  }
  // `RpcStub<T>` resolves to `Provider<T> & StubBase<T>`, an intersection with no
  // `RpcStub` symbol; recover `T` from the `__RPC_STUB_BRAND` marker it carries.
  let brand = checker.getPropertyOfType(type, "__RPC_STUB_BRAND");
  let decl = brand?.valueDeclaration ?? brand?.declarations?.[0];
  if (brand && decl) return checker.getTypeOfSymbolAtLocation(brand, decl);
  return type;
}

function isTooGeneric(type: ts.Type): boolean {
  let flags = type.getFlags();
  if (flags & ts.TypeFlags.TypeParameter) return true;
  if (flags & ts.TypeFlags.Any) return true;
  if (flags & ts.TypeFlags.Unknown) return true;
  if (flags & ts.TypeFlags.Never) return true;
  let name = type.getSymbol()?.getName();
  if (name === "RpcTarget" || name === "WorkerEntrypoint") return true;
  return false;
}

class ValidatorDedup {
  #emitted = new Map<
    string,
    { bindingName: string; shape: ServiceShape; signature: string }[]
  >();
  #order: {
    bindingName: string;
    shape: ServiceShape;
    side: "server" | "client";
  }[] = [];

  bind(shape: ServiceShape, side: "server" | "client"): string {
    let key = `${side}:${shape.name}`;
    let entries = this.#emitted.get(key) ?? [];
    let signature = serviceSignature(shape);
    let existing = entries.find((entry) => entry.signature === signature);
    if (existing) return existing.bindingName;
    let suffix = entries.length === 0 ? "" : `_${entries.length + 1}`;
    let bindingName = `__capnweb_validate_${sanitize(
      shape.name
    )}_${side}${suffix}`;
    let entry = { bindingName, shape, signature };
    entries.push(entry);
    this.#emitted.set(key, entries);
    this.#order.push({ bindingName, shape, side });
    return bindingName;
  }

  emitOrder(): {
    bindingName: string;
    shape: ServiceShape;
    side: "server" | "client";
  }[] {
    return this.#order;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function serviceSignature(shape: ServiceShape): string {
  return JSON.stringify({
    targetKind: shape.targetKind ?? null,
    passthrough: shape.passthrough ?? [],
    methods: shape.methods.map((method) =>
      method.skipValidation
        ? {
            name: method.name,
            unchecked: true,
          }
        : {
            name: method.name,
            params: method.params.map((param) => typeSignature(param)),
            rest: method.rest ? typeSignature(method.rest) : null,
            returns: typeSignature(method.returns),
            // A getter and a same-named no-arg method share params/returns;
            // isGetter must distinguish them so dedup does not reuse one for the
            // other (the runtime validates a getter on read, a method on call).
            isGetter: method.isGetter ?? false,
          }
    ),
  });
}

function typeSignature(shape: TypeShape): unknown {
  switch (shape.kind) {
    case "literal":
      return [shape.kind, shape.value];
    case "array":
      return [shape.kind, typeSignature(shape.element)];
    case "map":
      return [shape.kind, typeSignature(shape.key), typeSignature(shape.value)];
    case "set":
      return [shape.kind, typeSignature(shape.element)];
    case "tuple":
      return [
        shape.kind,
        shape.elements.map((element) => typeSignature(element)),
        shape.minLength ?? null,
        shape.rest ? typeSignature(shape.rest) : null,
      ];
    case "object":
      return [
        shape.kind,
        shape.name,
        sortedEntries(shape.properties),
        shape.index ? typeSignature(shape.index) : null,
      ];
    case "union":
      return [
        shape.kind,
        shape.branches.map((branch) => typeSignature(branch)),
      ];
    case "ref":
      return [shape.kind, shape.id];
    case "typedArray":
      return [shape.kind, shape.name];
    case "stub":
      return [
        shape.kind,
        shape.service ? serviceSignature(shape.service) : null,
      ];
    case "unsupported":
      return [
        shape.kind,
        shape.reason,
        shape.typeExpr ?? null,
        shape.fixHint ?? null,
      ];
    default:
      return [shape.kind];
  }
}

function sortedEntries(properties: Record<string, TypeShape>): unknown[] {
  return Object.entries(properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, typeSignature(value)]);
}

function buildError(sf: ts.SourceFile, node: ts.Node, message: string): Error {
  return buildErrorAt(sf, node.getStart(sf), message);
}

function buildErrorAt(sf: ts.SourceFile, pos: number, message: string): Error {
  return new Error(`${formatLocation(sf, pos)}: ${message}`);
}
