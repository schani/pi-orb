import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
const root=new URL('../',import.meta.url);
const css=await readFile(new URL('apps/web/src/styles.css',root),'utf8');
let fonts=css.slice(0,css.indexOf('/* Signal / Boards'));
for(const match of [...fonts.matchAll(/url\("([^"]+)"\)/g)]) {
 const bytes=await readFile(new URL('apps/web/public'+match[1],root));
 fonts=fonts.replace(match[0],'url("data:font/woff2;base64,'+bytes.toString('base64')+'")');
}
const chartStart=css.indexOf('/* ---------- transcript charts:');
const chartCSS=css.slice(chartStart,css.indexOf('.tool-command {',chartStart));
const theme=css.match(/:root \{[\s\S]*?\n\}/)[0];
const bundle=await build({entryPoints:[new URL('token-usage-comparison.mjs',import.meta.url).pathname],bundle:true,write:false,format:'iife',platform:'browser',minify:true,legalComments:'inline'});
const script=bundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const inputs=['apps/web/src/lib/chart-render.ts','apps/web/src/lib/chart-spec.ts','apps/web/src/styles.css'];
const hashes=await Promise.all(inputs.map(async path=>path+' '+createHash('sha256').update(await readFile(new URL(path,root))).digest('hex')));
const template=await readFile(new URL('token-usage-comparison.template.html',import.meta.url),'utf8');
await writeFile(new URL('token-usage-comparison.html',import.meta.url),template.replace('__SHARED_CSS__',()=>fonts+theme+chartCSS).replace('__BUNDLE__',()=>script).replace('__SOURCES__',()=>hashes.join('\n')));
console.log('Built token-usage-comparison.html from shared in-chat chart sources.');
