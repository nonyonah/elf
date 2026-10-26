import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { ParsedComponent } from "./types.js";

/** Every file with one of these extensions is treated as one component. */
export const COMPONENT_EXTENSIONS = [".tsx", ".jsx", ".vue", ".svelte", ".astro"];
const SFC_EXTENSIONS = new Set([".vue", ".svelte"]);

/** `<relative/path.tsx>#<Name>` — the identity used across runs and sidecars. */
export function codeKeyFor(relativePath: string, name: string): string {
  return `${relativePath.split(sep).join("/")}#${name}`;
}

/** Walks the components folder (recursively) and parses every component file. */
export function parseComponents(componentsDir: string): ParsedComponent[] {
  const files = collectFiles(componentsDir).sort();
  return files.map((file) => parseComponent(componentsDir, file));
}

export function parseComponent(componentsDir: string, file: string): ParsedComponent {
  const relativePath = relative(componentsDir, file).split(sep).join("/");
  const name = basename(file, extname(file));
  const codeKey = codeKeyFor(relativePath, name);
  const source = readFileSync(file, "utf8");

  const extension = extname(file);
  const { variantProps, imports } =
    extension === ".astro"
      ? parseAstro(source, file)
      : SFC_EXTENSIONS.has(extension)
        ? parseSfc(source, file, extension)
        : parseTs(source, file, extension === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);

  const dependencies: string[] = [];
  for (const specifier of imports) {
    const target = resolveImport(file, specifier, componentsDir);
    if (!target || target === file) continue;
    const dependency = codeKeyFor(
      relative(componentsDir, target).split(sep).join("/"),
      basename(target, extname(target)),
    );
    if (!dependencies.includes(dependency)) dependencies.push(dependency);
  }

  let deprecated: string | undefined;
  if (extension === ".tsx" || extension === ".jsx") {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, extension === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
    for (const statement of tree.statements) {
      const named = (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name;
      const variable = ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name);
      if (!named && !variable) continue;
      const tag = ts.getJSDocDeprecatedTag(statement);
      if (tag) deprecated = typeof tag.comment === "string" ? tag.comment : "Marked @deprecated in source";
    }
  }
  return { name, codeKey, file: relativePath, variantProps, dependencies, ...(deprecated !== undefined ? {deprecated} : {}) };
}

interface Extraction {
  variantProps: ParsedComponent["variantProps"];
  imports: string[];
}

function parseTs(source: string, fileName: string, kind: ts.ScriptKind): Extraction {
  return extract(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind));
}

function parseAstro(source: string, fileName: string): Extraction {
  // Everything before the second `---` is the frontmatter, written in TS.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return { variantProps: [], imports: [] };

  const frontmatter = ts.createSourceFile(
    `${fileName}.frontmatter.ts`,
    match[1],
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return extract(frontmatter);
}

/** Vue and Svelte single-file components: parse every `<script>` block as TS/JS. */
function parseSfc(source: string, fileName: string, extension: string): Extraction {
  const result: Extraction = { variantProps: [], imports: [] };
  const seen = new Set<string>();

  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(source)) !== null) {
    const isTs = /\blang\s*=\s*["']tsx?["']/.test(match[1]);
    const sourceFile = ts.createSourceFile(
      `${fileName}.script.${isTs ? "ts" : "js"}`,
      match[2],
      ts.ScriptTarget.Latest,
      true,
      isTs ? ts.ScriptKind.TS : ts.ScriptKind.JSX,
    );
    const extraction = extract(sourceFile, { svelteLets: extension === ".svelte" });

    for (const prop of extraction.variantProps) {
      if (seen.has(prop.name)) continue;
      seen.add(prop.name);
      result.variantProps.push(prop);
    }
    for (const specifier of extraction.imports) {
      if (!result.imports.includes(specifier)) result.imports.push(specifier);
    }
  }

  return result;
}

interface ExtractOptions {
  /** Svelte 4 declares props as `export let size: "sm" | "md"`. */
  svelteLets?: boolean;
}

/**
 * Finds variant props: string-literal unions on the props type (first
 * `Props` / `<Name>Props` interface or alias — also what `defineProps<Props>()`
 * refers to), inline `defineProps<{ … }>()` type literals (Vue), and
 * `export let … : "a" | "b"` (Svelte 4). Imports and re-exports feed the
 * dependency graph.
 */
function extract(sourceFile: ts.SourceFile, options: ExtractOptions = {}): Extraction {
  const variantProps: ParsedComponent["variantProps"] = [];
  const seen = new Set<string>();
  const add = (name: string, values: string[] | null): void => {
    if (!values || values.length === 0 || seen.has(name)) return;
    seen.add(name);
    variantProps.push({ name, values });
  };

  const propsType = findPropsType(sourceFile);
  if (propsType) collectProps(propsType, add);

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || calleeName(node) !== "defineProps") return;
    const [typeArgument] = node.typeArguments ?? [];
    if (typeArgument && ts.isTypeLiteralNode(typeArgument)) collectMembers(typeArgument.members, add);
  });

  if (options.svelteLets) {
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.type) continue;
        add(declaration.name.text, stringLiteralUnion(declaration.type));
      }
    }
  }

  const imports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    }
  }

  return { variantProps, imports };
}

function findPropsType(
  sourceFile: ts.SourceFile,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) continue;
    const isProps =
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      (statement.name.text === "Props" || statement.name.text.endsWith("Props"));
    if (isProps) return statement as ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
  }
  return null;
}

function collectProps(
  type: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  add: (name: string, values: string[] | null) => void,
): void {
  const members: readonly ts.TypeElement[] = ts.isInterfaceDeclaration(type)
    ? type.members
    : ts.isTypeLiteralNode(type.type)
      ? type.type.members
      : [];
  collectMembers(members, add);
}

function collectMembers(
  members: readonly ts.TypeElement[],
  add: (name: string, values: string[] | null) => void,
): void {
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    add(member.name.getText(), stringLiteralUnion(member.type));
  }
}

/** `"sm" | "md"` → ["sm", "md"]; anything else → null. */
function stringLiteralUnion(type: ts.TypeNode): string[] | null {
  if (!ts.isUnionTypeNode(type)) return null;
  const values: string[] = [];
  for (const member of type.types) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return null;
    values.push(member.literal.text);
  }
  return values;
}

function calleeName(node: ts.CallExpression): string {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return "";
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Resolves a relative import to a component file inside the folder, or null. */
function resolveImport(importer: string, specifier: string, componentsDir: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier);

  const candidates = [
    base,
    ...COMPONENT_EXTENSIONS.map((extension) => base + extension),
    ...COMPONENT_EXTENSIONS.map((extension) => resolve(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const inside = !relative(componentsDir, candidate).startsWith("..");
      return inside ? candidate : null;
    }
  }
  return null;
}

function collectFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const path = resolve(dir, entry);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Component paths must not be symbolic links: ${path}.`);
    if (statSync(path).isDirectory()) {
      found.push(...collectFiles(path));
    } else if (COMPONENT_EXTENSIONS.includes(extname(entry))) {
      found.push(path);
    }
  }
  return found;
}
