/** Structural source fact for criterion65/v69.2; not a browser/security verdict. */
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const ts=createRequire(new URL('../web/package.json',import.meta.url))('typescript');
export const PORTAL_CALL_CHAIN_FACT={path:'web/src/pages/UseWorkbench.tsx -> web/src/components/GoFrame.tsx',needle:'v69.2:UseWorkbench.return.GoFrame(wid=w.id)->GoFrame.return.iframe(src=/go/${wid}/)'};
const parse=(name,text)=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const expr=(attr)=>attr?.initializer&&ts.isJsxExpression(attr.initializer)?attr.initializer.expression:null;
const attrs=(node,name)=>node.attributes.properties.filter(a=>ts.isJsxAttribute(a)&&a.name.getText()===name);
const safeAttr=(node,name)=>!node.attributes.properties.some(ts.isJsxSpreadAttribute)&&attrs(node,name).length===1?expr(attrs(node,name)[0]):null;
const ident=(n,name)=>!!n&&ts.isIdentifier(n)&&n.text===name;
function exportedFunction(file,name){return file.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name&&s.modifiers?.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword));}
function jsxRoot(expression){
 while(expression&&ts.isParenthesizedExpression(expression))expression=expression.expression;
 return expression&&(ts.isJsxElement(expression)||ts.isJsxSelfClosingElement(expression)||ts.isJsxFragment(expression))?expression:null;
}
function tagsIn(expression){
 const tags=[];const walk=n=>{if(ts.isFunctionLike(n))return;if(ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n))tags.push(n);ts.forEachChild(n,walk)};
 walk(expression);return tags;
}
function directTags(expression){
 const root=jsxRoot(expression);if(!root)return [];
 const tags=[];const tag=n=>ts.isJsxElement(n)?n.openingElement:ts.isJsxSelfClosingElement(n)?n:null;
 const own=tag(root);if(own)tags.push(own);
 if(ts.isJsxElement(root)||ts.isJsxFragment(root))for(const child of root.children){const t=tag(child);if(t)tags.push(t);}
 return tags;
}
function altersWid(body){
 let found=false;
 const contains=n=>{if(!n)return false;if(ts.isIdentifier(n))return n.text==='wid';return ts.forEachChild(n,contains)===true;};
 const walk=n=>{
  if((ts.isVariableDeclaration(n)||ts.isParameter(n)||ts.isBindingElement(n))&&contains(n.name))found=true;
  if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&contains(n.left))found=true;
  if((ts.isPrefixUnaryExpression(n)||ts.isPostfixUnaryExpression(n))&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(n.operator)&&contains(n.operand))found=true;
  if((ts.isForOfStatement(n)||ts.isForInStatement(n))&&contains(n.initializer))found=true;
  ts.forEachChild(n,walk);
 };
 walk(body);return found;
}
function bindingContains(name,text){
 if(!name)return false;
 if(ts.isIdentifier(name))return name.text===text;
 if(ts.isObjectBindingPattern(name)||ts.isArrayBindingPattern(name))return name.elements.some(e=>ts.isBindingElement(e)&&bindingContains(e.name,text));
 return false;
}
function shadowsGoFrame(file){
 let found=false;
 const walk=n=>{
  if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)&&n.moduleSpecifier.text==='../components/GoFrame'&&ident(n.importClause?.name,'GoFrame')){
   if(n.importClause.namedBindings)walk(n.importClause.namedBindings);
   return; // The one required default import is the only permitted binding.
  }
  if((ts.isVariableDeclaration(n)||ts.isParameter(n)||ts.isBindingElement(n)||
    ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isClassDeclaration(n)||ts.isClassExpression(n)||
    ts.isImportClause(n)||ts.isImportSpecifier(n)||ts.isNamespaceImport(n)||ts.isEnumDeclaration(n))&&bindingContains(n.name,'GoFrame'))found=true;
  ts.forEachChild(n,walk);
 };
 walk(file);return found;
}
const property=(n,base,name)=>!!n&&ts.isPropertyAccessExpression(n)&&ident(n.expression,base)&&n.name.text===name;
function attributeShape(node,rules){
 const seen=new Set();
 for(const attr of node.attributes.properties){
  if(!ts.isJsxAttribute(attr))return false;
  const name=attr.name.getText();if(seen.has(name)||!rules[name])return false;seen.add(name);
  if(!rules[name](attr))return false;
 }
 return true;
}
const literalAttr=a=>!!a.initializer&&(ts.isStringLiteral(a.initializer)||!!expr(a)&&ts.isStringLiteral(expr(a)));
const idAttr=name=>a=>ident(expr(a),name);
function finalReturnedTags(fn){
 // Restricted current shape only: top-level variables, JSX-only early guards,
 // then one final top-level JSX return. No CFG/data-flow claim is made.
 const statements=fn.body.statements,last=statements.at(-1);
 if(!last||!ts.isReturnStatement(last)||!jsxRoot(last.expression))return null;
 for(const statement of statements.slice(0,-1)){
  if(ts.isVariableStatement(statement))continue;
  if(!ts.isIfStatement(statement)||statement.elseStatement||!ts.isBlock(statement.thenStatement))return null;
  const branch=statement.thenStatement.statements;
  if(branch.length!==1||!ts.isReturnStatement(branch[0])||!jsxRoot(branch[0].expression))return null;
  if(tagsIn(branch[0].expression).some(n=>ident(n.tagName,'iframe')||ident(n.tagName,'GoFrame')))return null;
 }
 return tagsIn(last.expression);
}
export function portalCallChainPresent(pageText,frameText){
 const page=parse('UseWorkbench.tsx',pageText),frame=parse('GoFrame.tsx',frameText);
 if(page.parseDiagnostics.length||frame.parseDiagnostics.length)return false;
 const pageFn=exportedFunction(page,'UseWorkbench'),frameFn=exportedFunction(frame,'GoFrame');
 if(!pageFn?.body||!frameFn?.body)return false;
 const imported=page.statements.filter(ts.isImportDeclaration).some(s=>ts.isStringLiteral(s.moduleSpecifier)&&s.moduleSpecifier.text==='../components/GoFrame'&&ident(s.importClause?.name,'GoFrame'));
 if(!imported||shadowsGoFrame(page))return false;
 const calls=finalReturnedTags(pageFn);if(!calls||calls.some(n=>ident(n.tagName,'iframe')))return false;
 const components=calls.filter(n=>ident(n.tagName,'GoFrame'));if(components.length!==1)return false;
 if(!directTags(pageFn.body.statements.at(-1).expression).includes(components[0]))return false;
 if(!attributeShape(components[0],{wid:a=>property(expr(a),'w','id'),name:a=>property(expr(a),'w','name'),frameKey:idAttr('frameKey'),className:literalAttr}))return false;
 const wid=safeAttr(components[0],'wid');if(!wid||!ts.isPropertyAccessExpression(wid)||!ident(wid.expression,'w')||wid.name.text!=='id')return false;
 // Pin the parameter and its const source; an unused string/comment is not a route.
 const binding=frameFn.parameters[0]?.name;
 if(!binding||!ts.isObjectBindingPattern(binding)||!binding.elements.some(e=>ident(e.name,'wid')&&!e.propertyName&&!e.initializer))return false;
 if(altersWid(frameFn.body))return false;
 const declarations=frameFn.body.statements.filter(ts.isVariableStatement).flatMap(s=>s.declarationList.declarations.map(d=>({d,isConst:!!(s.declarationList.flags&ts.NodeFlags.Const)}))).filter(x=>ident(x.d.name,'src'));
 if(declarations.length!==1||!declarations[0].isConst)return false;
 const src=declarations[0].d.initializer;
 if(!src||!ts.isTemplateExpression(src)||src.head.text!=='/go/'||src.templateSpans.length!==1||!ident(src.templateSpans[0].expression,'wid')||src.templateSpans[0].literal.text!=='/')return false;
 const finalFrameTags=finalReturnedTags(frameFn);if(!finalFrameTags)return false;
 const frames=finalFrameTags.filter(n=>ident(n.tagName,'iframe'));
 return frames.length===1&&directTags(frameFn.body.statements.at(-1).expression).includes(frames[0])&&
  attributeShape(frames[0],{key:idAttr('frameKey'),className:idAttr('className'),src:idAttr('src'),title:idAttr('name'),allow:literalAttr})&&ident(safeAttr(frames[0],'src'),'src');
}
export function readPortalCallChainFact(root){
 let present=0;
 try{present=Number(portalCallChainPresent(readFileSync(join(root,'web/src/pages/UseWorkbench.tsx'),'utf8'),readFileSync(join(root,'web/src/components/GoFrame.tsx'),'utf8')))}catch{ /* missing source is a false fact, never forced present */ }
 return {...PORTAL_CALL_CHAIN_FACT,present};
}
