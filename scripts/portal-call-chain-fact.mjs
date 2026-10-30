/** Structural source fact for criterion65/v69; not a browser/security verdict. */
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const ts=createRequire(new URL('../web/package.json',import.meta.url))('typescript');
export const PORTAL_CALL_CHAIN_FACT={path:'web/src/pages/UseWorkbench.tsx -> web/src/components/GoFrame.tsx',needle:'v69:UseWorkbench.return.GoFrame(wid=w.id)->GoFrame.return.iframe(src=/go/${wid}/)'};
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
 if(!imported)return false;
 const calls=finalReturnedTags(pageFn);if(!calls||calls.some(n=>ident(n.tagName,'iframe')))return false;
 const components=calls.filter(n=>ident(n.tagName,'GoFrame'));if(components.length!==1)return false;
 const wid=safeAttr(components[0],'wid');if(!wid||!ts.isPropertyAccessExpression(wid)||!ident(wid.expression,'w')||wid.name.text!=='id')return false;
 // Pin the parameter and its const source; an unused string/comment is not a route.
 const binding=frameFn.parameters[0]?.name;
 if(!binding||!ts.isObjectBindingPattern(binding)||!binding.elements.some(e=>ident(e.name,'wid')&&!e.propertyName))return false;
 const declarations=frameFn.body.statements.filter(ts.isVariableStatement).flatMap(s=>s.declarationList.declarations.map(d=>({d,isConst:!!(s.declarationList.flags&ts.NodeFlags.Const)}))).filter(x=>ident(x.d.name,'src'));
 if(declarations.length!==1||!declarations[0].isConst)return false;
 const src=declarations[0].d.initializer;
 if(!src||!ts.isTemplateExpression(src)||src.head.text!=='/go/'||src.templateSpans.length!==1||!ident(src.templateSpans[0].expression,'wid')||src.templateSpans[0].literal.text!=='/')return false;
 const finalFrameTags=finalReturnedTags(frameFn);if(!finalFrameTags)return false;
 const frames=finalFrameTags.filter(n=>ident(n.tagName,'iframe'));
 return frames.length===1&&ident(safeAttr(frames[0],'src'),'src');
}
export function readPortalCallChainFact(root){
 let present=0;
 try{present=Number(portalCallChainPresent(readFileSync(join(root,'web/src/pages/UseWorkbench.tsx'),'utf8'),readFileSync(join(root,'web/src/components/GoFrame.tsx'),'utf8')))}catch{ /* missing source is a false fact, never forced present */ }
 return {...PORTAL_CALL_CHAIN_FACT,present};
}
