import ts from "typescript";
import { readSource } from "../discovery.js";
import { tokensFromTailwindTheme } from "./tailwind.js";
import type { Token } from "../core/types.js";

/** Read literal themes without importing the config or running its plugins. */
export function parseStaticTailwind(path: string): Token[] {
  const tree = ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true);
  const constants = new Map<string, ts.Expression>();
  let config: ts.Expression | undefined;
  for (const statement of tree.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
    }
    if (ts.isExportAssignment(statement)) config = statement.expression;
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && ["module.exports", "exports.default"].includes(statement.expression.left.getText(tree))) config = statement.expression.right;
  }
  const unwrap = (node: ts.Expression, seen = new Set<string>()): ts.Expression => {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return unwrap(node.expression, seen);
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "defineConfig" && node.arguments[0]) return unwrap(node.arguments[0], seen);
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) { seen.add(node.text); return unwrap(constants.get(node.text)!, seen); }
    return node;
  };
  const literal = (expression: ts.Expression, depth = 0): unknown => {
    if (depth > 32) throw new Error(`Tailwind theme is too deeply nested: ${path}`);
    const node = unwrap(expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => literal(item as ts.Expression, depth + 1));
    if (ts.isObjectLiteralExpression(node)) {
      const result = Object.create(null) as Record<string, unknown>;
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) { Object.assign(result, literal(item.expression, depth + 1)); continue; }
        if (ts.isShorthandPropertyAssignment(item)) { result[item.name.text] = literal(item.name, depth + 1); continue; }
        if (!ts.isPropertyAssignment(item) || ts.isComputedPropertyName(item.name)) throw new Error(`Dynamic Tailwind theme cannot be discovered safely: ${path}. Export literal tokens in CSS or JSON.`);
        const key = item.name.getText(tree).replace(/^["']|["']$/g, "");
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`Unsafe theme key: ${key}`);
        result[key] = literal(item.initializer, depth + 1);
      }
      return result;
    }
    throw new Error(`Dynamic Tailwind theme cannot be discovered safely: ${path}. Export literal tokens in CSS or JSON.`);
  };
  if (!config) return [];
  const root = unwrap(config);
  if (!ts.isObjectLiteralExpression(root)) throw new Error(`Cannot statically read Tailwind config: ${path}`);
  if (root.properties.some(item => ts.isSpreadAssignment(item))) throw new Error(`Cannot statically resolve a spread Tailwind config: ${path}. Export literal tokens in CSS or JSON.`);
  const theme = root.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(tree).replace(/["']/g, "") === "theme");
  return theme && ts.isPropertyAssignment(theme) ? tokensFromTailwindTheme(literal(theme.initializer) as Parameters<typeof tokensFromTailwindTheme>[0]) : [];
}
