import ts from 'typescript';
import {basename,dirname,extname,resolve} from 'node:path';

export interface ComponentImportOptions {nodeId:string;framework:'react';library:string;path:string;reuse:string[];}
/** Parse source without loading project configuration, dependencies, or compiler plugins. */
export function validateImportedComponent(code:unknown,options:ComponentImportOptions,root:string,reusePaths:string[]):string {
 if (typeof code!=='string' || !code.trim() || Buffer.byteLength(code)>128000) throw new Error('Component code must be nonempty text under 128 KB.');
 if (options.framework!=='react' || !options.path.endsWith('.tsx')) throw new Error('This preview supports React TSX component drafts.');
 const name=basename(options.path,'.tsx');
 if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error('Use a PascalCase component filename, such as ImportedAlert.tsx.');
 const source=ts.createSourceFile(options.path,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 if ((source as any).parseDiagnostics.length) throw new Error('Fix the TSX syntax before reviewing this import.');
 const destination=resolve(root,options.path);
 const allowedPath=(specifier:string):boolean=>{
  if(specifier.includes('\\')||!specifier.startsWith('.')&&specifier.split('/').includes('..')||specifier.includes('\0'))return false;
  if (specifier==='react' || specifier==='react/jsx-runtime') return true;
  if (options.library!=='native' && options.library!=='shadcn' && (specifier===options.library || specifier.startsWith(options.library+'/'))) return true;
  if (!specifier.startsWith('.')) return false;
  const target=resolve(dirname(destination),specifier);
  return reusePaths.some(path=>path===target || path.slice(0,-extname(path).length)===target);
 };
 let exported=false;
 const forbidden=new Set(['eval','Function','require','fetch','WebSocket','XMLHttpRequest','Worker','process','globalThis','window','document','localStorage','sessionStorage']);
 const visit=(node:ts.Node):void=>{
  if (ts.isIdentifier(node) && forbidden.has(node.text)) throw new Error(`Generated code uses a restricted API: ${node.text}. Remove it before review.`);
  if (ts.isCallExpression(node) && node.expression.kind===ts.SyntaxKind.ImportKeyword) throw new Error('Dynamic imports are not allowed in component drafts.');
  if (ts.isPropertyAccessExpression(node) && ['constructor','__proto__'].includes(node.name.text) || ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && ['constructor','__proto__'].includes(node.argumentExpression.text)) throw new Error('Dynamic code access is not allowed.');
  if(options.library==='@heroui/react' && ts.isImportSpecifier(node) && (node.propertyName?.text||node.name.text)==='HeroUIProvider')throw new Error('HeroUI v3 requires no HeroUIProvider. Use v3 component APIs.');
  if (ts.isImportDeclaration(node)) {
   if (!ts.isStringLiteral(node.moduleSpecifier) || !allowedPath(node.moduleSpecifier.text)) throw new Error('Use only React, the confirmed installed library, or explicitly selected local components.');
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier) throw new Error('Module re-exports are not part of a component import.');
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
   if (['script','iframe','object','embed'].includes(node.tagName.getText(source).toLowerCase())) throw new Error('Embedded executable content is not allowed.');
  }
  if (ts.isJsxAttribute(node) && node.name.getText(source)==='dangerouslySetInnerHTML') throw new Error('Raw HTML injection is not allowed.');
  if (ts.isStringLiteralLike(node) && /^\s*(javascript:|data:text\/html)/i.test(node.text)) throw new Error('Executable URLs are not allowed.');
  if ((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isVariableStatement(node)) && ts.getModifiers(node)?.some(item=>item.kind===ts.SyntaxKind.ExportKeyword)) {
   if (ts.isVariableStatement(node)) exported ||= node.declarationList.declarations.some(item=>ts.isIdentifier(item.name)&&item.name.text===name);
   else exported ||= node.name?.text===name;
  }
  ts.forEachChild(node,visit);
 };
 visit(source);
 if (!exported) throw new Error(`Export the component as ${name} to match its filename.`);
 return code;
}
