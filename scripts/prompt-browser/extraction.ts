import { err, ok, Result } from "neverthrow";
import { type ESTree, parseSync } from "rolldown/utils";
import type { ExtractionSelector, PromptError } from "./types.ts";

type Node = ESTree.Node;
type CodeSelector = Extract<ExtractionSelector, { kind: "code" }>;
type Span = { start: number; end: number; text: string };
export interface Extracted {
  content: string;
  variables?: string[];
  replace(content: string): Result<string, PromptError>;
}
const unavailable = (): PromptError => ({
  code: "not_found",
  message: "Prompt extraction is unavailable: selector must identify exactly one supported prompt.",
});
const invalid = (): PromptError => ({
  code: "invalid_request",
  message: "Keep every {{variable}} placeholder unchanged and in order.",
});
const separatorError = (): PromptError => ({
  code: "invalid_request",
  message: "Keep the separators around template variables unchanged.",
});
const syntax = (): PromptError => ({
  code: "syntax",
  message: "Prompt source could not be parsed.",
});
const isNode = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && "type" in value;
function walk(root: Node): Node[] {
  const result: Node[] = [root];
  for (const value of Object.values(root)) {
    if (isNode(value)) result.push(...walk(value));
    else if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) result.push(...walk(child));
    }
  }
  return result;
}
const keyName = (node: Node) =>
  node.type === "Identifier" ? node.name : node.type === "Literal" ? node.value : undefined;
const isString = (node: Node): node is ESTree.StringLiteral =>
  node.type === "Literal" && typeof node.value === "string";
function staticText(node: Node): string | undefined {
  if (isString(node)) return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked ?? undefined;
  return undefined;
}
function joined(node: Node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    keyName(node.callee.property) !== "join" ||
    node.callee.object.type !== "ArrayExpression" ||
    node.arguments.length !== 1 ||
    !isString(node.arguments[0])
  )
    return undefined;
  return { array: node.callee.object, separator: node.arguments[0].value };
}
function locate(program: Node, selector: CodeSelector): Result<Node, PromptError> {
  let roots: Node[] = [program];
  const owner = selector.owner;
  if (owner) {
    roots = [];
    for (const node of walk(program)) {
      if (
        owner.kind === "variable" &&
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.id.name === owner.name &&
        node.init
      )
        roots.push(node.init);
      if (owner.kind === "function") {
        if (
          (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") &&
          node.id?.name === owner.name
        )
          roots.push(node);
        if (
          node.type === "VariableDeclarator" &&
          node.id.type === "Identifier" &&
          node.id.name === owner.name &&
          node.init &&
          (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
        )
          roots.push(node.init);
        if (
          node.type === "Property" &&
          keyName(node.key) === owner.name &&
          (node.value.type === "FunctionExpression" ||
            node.value.type === "ArrowFunctionExpression")
        )
          roots.push(node.value);
        if (node.type === "MethodDefinition" && keyName(node.key) === owner.name)
          roots.push(node.value);
      }
      if (owner.kind === "property" && node.type === "Property" && keyName(node.key) === owner.name)
        roots.push(node.value);
      if (owner.kind === "tool" && node.type === "ObjectExpression") {
        const names = node.properties.filter(
          (p) =>
            p.type === "Property" &&
            keyName(p.key) === "name" &&
            isString(p.value) &&
            p.value.value === owner.name,
        );
        if (names.length === 1) {
          for (const property of node.properties)
            if (property.type === "Property" && keyName(property.key) === "description")
              roots.push(property.value);
        }
      }
    }
  }
  if (roots.length !== 1) return err(unavailable());
  let target: unknown = roots[0];
  for (const part of selector.path ?? []) {
    if (!target || typeof target !== "object") return err(unavailable());
    target = (target as Record<string | number, unknown>)[part];
  }
  if (!isNode(target)) return err(unavailable());
  const matches = (node: Node) =>
    selector.node === "string"
      ? isString(node)
      : selector.node === "template"
        ? node.type === "TemplateLiteral"
        : joined(node) !== undefined;
  const candidates = (matches(target) ? [target] : walk(target).filter(matches)).sort(
    (a, b) => a.start - b.start,
  );
  if (selector.ordinal !== undefined) {
    if (
      !Number.isInteger(selector.ordinal) ||
      selector.ordinal < 0 ||
      !candidates[selector.ordinal]
    )
      return err(unavailable());
    return ok(candidates[selector.ordinal]);
  }
  return candidates.length === 1 ? ok(candidates[0]) : err(unavailable());
}
function apply(source: string, spans: Span[]): string {
  let result = source;
  for (const span of [...spans].sort((a, b) => b.start - a.start))
    result = result.slice(0, span.start) + span.text + result.slice(span.end);
  return result;
}
function plain(
  source: string,
  start: number,
  end: number,
  content: string,
  encode: (value: string) => string = (value) => value,
): Extracted {
  return {
    content,
    replace: (value) =>
      ok(value === content ? source : apply(source, [{ start, end, text: encode(value) }])),
  };
}
function aliases(count: number, selected?: readonly string[]): Result<string[], PromptError> {
  const names = selected
    ? [...selected]
    : Array.from({ length: count }, (_, i) => `variable${i + 1}`);
  return names.length === count &&
    new Set(names).size === count &&
    names.every((name) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(name))
    ? ok(names)
    : err(unavailable());
}
function splitTokens(value: string, variables: readonly string[]): Result<string[], PromptError> {
  if (variables.length === 0) return ok([value]);
  const tokens = [...value.matchAll(/\{\{[^{}]*\}\}/g)];
  if (
    tokens.length !== variables.length ||
    tokens.some((match, index) => match[0] !== `{{${variables[index]}}}`)
  )
    return err(invalid());
  const parts: string[] = [];
  let start = 0;
  for (const token of tokens) {
    parts.push(value.slice(start, token.index));
    start = token.index + token[0].length;
  }
  parts.push(value.slice(start));
  return ok(parts);
}
const encodeQuasi = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\r/g, "\\r");

function template(
  source: string,
  node: ESTree.TemplateLiteral,
  selector: CodeSelector,
): Result<Extracted, PromptError> {
  return aliases(node.expressions.length, selector.variables).andThen((variables) => {
    if (node.quasis.some((quasi) => quasi.value.cooked === null)) return err(unavailable());
    const parts = node.quasis.map((quasi) => quasi.value.cooked ?? "");
    const content = parts
      .map((part, index) => part + (index < variables.length ? `{{${variables[index]}}}` : ""))
      .join("");
    if (splitTokens(content, variables).isErr()) return err(unavailable());
    return ok({
      content,
      ...(variables.length ? { variables } : {}),
      replace(value: string) {
        if (value === content) return ok(source);
        return splitTokens(value, variables).map((updated) =>
          apply(
            source,
            node.quasis.map((quasi, index) => ({
              start: quasi.start + 1,
              end: quasi.end - (quasi.tail ? 1 : 2),
              text: encodeQuasi(updated[index]),
            })),
          ),
        );
      },
    });
  });
}
function joinedArray(
  source: string,
  node: Node,
  selector: CodeSelector,
): Result<Extracted, PromptError> {
  const selected = joined(node);
  if (!selected) return err(unavailable());
  const { array, separator } = selected;
  if (array.elements.some((item) => !item)) return err(unavailable());
  const elements = array.elements as Node[];
  const dynamic = elements.filter((item) => staticText(item) === undefined);
  return aliases(dynamic.length, selector.variables).andThen((variables) => {
    let index = 0;
    const content = elements
      .map((item) => staticText(item) ?? `{{${variables[index++]}}}`)
      .join(separator);
    if (splitTokens(content, variables).isErr()) return err(unavailable());
    const gaps: ({ first: Node; last: Node } | undefined)[] = [];
    let run: { first: Node; last: Node } | undefined;
    for (const item of elements) {
      if (staticText(item) === undefined) {
        gaps.push(run);
        run = undefined;
      } else if (run) run.last = item;
      else run = { first: item, last: item };
    }
    gaps.push(run);
    return ok({
      content,
      ...(variables.length ? { variables } : {}),
      replace(value: string) {
        if (value === content) return ok(source);
        return splitTokens(value, variables).andThen((parts) => {
          const spans: Span[] = [];
          for (let i = 0; i < gaps.length; i++) {
            const gap = gaps[i];
            const prefix = i > 0 ? separator : "";
            const suffix = i < variables.length ? separator : "";
            if (!gap && parts[i] === (i > 0 && i < variables.length ? separator : "")) continue;
            if (
              !parts[i].startsWith(prefix) ||
              !parts[i].endsWith(suffix) ||
              parts[i].length < prefix.length + suffix.length
            )
              return err(separatorError());
            const text = parts[i].slice(prefix.length, parts[i].length - suffix.length);
            if (gap) {
              spans.push({ start: gap.first.start, end: gap.last.end, text: JSON.stringify(text) });
            } else if (dynamic[i]) {
              spans.push({
                start: dynamic[i].start,
                end: dynamic[i].start,
                text: `${JSON.stringify(text)},`,
              });
            } else if (dynamic[i - 1]) {
              spans.push({
                start: dynamic[i - 1].end,
                end: dynamic[i - 1].end,
                text: `,${JSON.stringify(text)}`,
              });
            } else return err(separatorError());
          }
          return ok(apply(source, spans));
        });
      },
    });
  });
}
function markdown(source: string, selector: ExtractionSelector): Result<Extracted, PromptError> {
  if (selector.kind === "markdown") return ok(plain(source, 0, source.length, source));
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!header) return err(unavailable());
  if (selector.kind === "markdown-body")
    return ok(plain(source, header[0].length, source.length, source.slice(header[0].length)));
  const matches = [...header[1].matchAll(/^description:[ \t]*(.*)$/gm)];
  if (matches.length !== 1) return err(unavailable());
  const match = matches[0];
  const raw = match[1].replace(/\r$/, "");
  if (!raw || /^[|>!&*{[]/.test(raw)) return err(unavailable());
  let content: string;
  if (raw.startsWith('"')) {
    const decoded = Result.fromThrowable(() => JSON.parse(raw) as unknown, unavailable)();
    if (decoded.isErr() || typeof decoded.value !== "string") return err(unavailable());
    content = decoded.value;
  } else if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) return err(unavailable());
    content = raw.slice(1, -1).replace(/''/g, "'");
  } else {
    if (/\s#|:\s/.test(raw)) return err(unavailable());
    content = raw;
  }
  const start = header[0].indexOf(header[1]) + match.index + match[0].indexOf(match[1]);
  return ok(plain(source, start, start + raw.length, content, JSON.stringify));
}
export function extract(
  filename: string,
  source: string,
  selector?: ExtractionSelector,
): Result<Extracted, PromptError> {
  if (!selector) return err(unavailable());
  if (selector.kind !== "code") return markdown(source, selector);
  const parsed = Result.fromThrowable(() => parseSync(filename, source), syntax)();
  if (parsed.isErr()) return err(parsed.error);
  if (parsed.value.errors.length) return err(syntax());
  return locate(parsed.value.program, selector).andThen((node) => {
    if (isString(node)) return ok(plain(source, node.start, node.end, node.value, JSON.stringify));
    if (node.type === "TemplateLiteral") return template(source, node, selector);
    return joinedArray(source, node, selector);
  });
}
