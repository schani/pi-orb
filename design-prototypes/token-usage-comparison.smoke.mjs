import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const browser=await chromium.launch({executablePath:existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/Los_Angeles'});
const errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(/^(WARN|ERROR) |vega/i.test(m.text()) && ['error','warning'].includes(m.type()))errors.push(m.text());});
page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
const ready=async()=>expect(page.locator('[data-ready]')).toHaveAttribute('data-ready','true');
const dimmed=async()=>page.locator('[data-timeline] g.mark-line path').evaluateAll(ns=>ns.filter(n=>Number(n.getAttribute('opacity')||1)<.5).length);
try {
 await page.goto(process.env.STUDY_URL||pathToFileURL(new URL('./token-usage-comparison.html',import.meta.url).pathname).href);
 await page.evaluate(()=>document.fonts.ready);
 await ready();
 const a=await page.locator('.summary').boundingBox(),b=await page.locator('[data-timeline]').boundingBox();
 assert.ok(a.x+a.width<=b.x,'summary left of timeline');
 for(const [period,count] of [['day',96],['week',168],['month',120],['6months',183]]) {
  await page.locator('[data-period="'+period+'"]').click();await ready();
  const state=await page.evaluate(()=>window.usageStudy.state());
  assert.equal(state.buckets.length,count);
  assert.ok(state.spec.series.every(s=>s.points.length===count));
  assert.equal(state.xAxis.ticks.length,count);
  if(period==='6months')assert.ok(state.xAxis.ticks.every((t,i,ts)=>!i||t-ts[i-1]===86400000),'one tick per day');
  const tickNodes=page.locator('[data-timeline] g.mark-rule.role-axis-tick').last().locator('line');
  await expect(tickNodes).toHaveCount(count);
  if(period==='6months') {
   const labels=page.locator('[data-timeline] g.role-axis[aria-label^="X-axis"] g.role-axis-label text');
   await expect(labels.first()).toHaveText('Apr 13');
   await expect(labels.last()).toHaveText('Oct 12');
  }
  assert.equal(state.spec.series.flatMap(s=>s.points).reduce((n,p)=>n+p[1],0),state.summary.total);
  assert.equal(await page.locator('[data-timeline] g.mark-line path').count(),state.spec.series.length);
  const plot=await page.locator('[data-timeline] g.mark-group.role-scope').first().boundingBox();
  await page.mouse.move(plot.x+plot.width*.4,plot.y+plot.height*.5);
  await expect(page.locator('.chart-tip')).toBeVisible();
  await expect(page.locator('.chart-tip tr')).toHaveCount(state.spec.series.length+1);
  const vals=await page.locator('.chart-tip tr').allInnerTexts();
  assert.ok(vals.slice(1).every(v=>v.includes('tokens')),'counts and units');
  await page.mouse.move(0,0);await expect(page.locator('.chart-tip')).toBeHidden();
 }
 for(const split of ['use','model','tokens']) {
  await page.locator('[data-breakdown]').selectOption(split);await ready();
  const s=await page.evaluate(()=>window.usageStudy.state());
  const label=page.locator('[data-timeline] svg text').filter({hasText:new RegExp('^'+s.spec.series[0].name+' ')});
  await label.hover();
  await expect.poll(dimmed).toBe(s.spec.series.length-1);
  await page.mouse.move(0,0);await expect.poll(dimmed).toBe(0);
 }
 for(const measure of ['total','input','output']){await page.locator('[data-ranking]').selectOption(measure);await ready();await expect(page.locator('[data-orbs] svg')).toBeVisible();await expect(page.locator('[data-uses] svg')).toBeVisible();
  const clipped=await page.locator('[data-orbs] svg text,[data-uses] svg text').evaluateAll(ns=>ns.filter(n=>n.getBoundingClientRect().left<n.closest('svg').getBoundingClientRect().left-1).map(n=>n.textContent));
  assert.deepEqual(clipped,[],'chart labels must not clip');
 }
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});await ready();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no document overflow');
  if(width<600){
   await expect(page.locator('.chart-key')).toBeVisible();
   await page.locator('.chart-key [data-series]').first().hover();
   const n=await page.evaluate(()=>window.usageStudy.state().spec.series.length);
   await expect.poll(dimmed).toBe(n-1);await page.mouse.move(0,0);
   const controls=await page.locator('button:visible,select:visible').evaluateAll(ns=>ns.map(n=>({h:n.getBoundingClientRect().height,font:parseFloat(getComputedStyle(n).fontSize),tag:n.tagName})));
   assert.ok(controls.every(n=>n.h>=44),'phone targets');assert.ok(controls.filter(n=>n.tag==='SELECT').every(n=>n.font>=16));
  }
  await page.screenshot({path:'/tmp/token-usage-comparison-'+width+'.png',fullPage:true});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 assert.ok(await page.evaluate(()=>[...document.fonts].some(f=>f.family.includes('JetBrains Mono')&&f.status==='loaded')));
 console.log('PASS: shared renderer, popovers, end-label/key isolation, left summary, 96/168/120/183 ticks and points, three breakdowns/rankings, no remote assets, desktop/phone containment.');
} catch(e){writeFileSync('/tmp/token-usage-comparison-first-failure.txt',String(e.stack));await page.screenshot({path:'/tmp/token-usage-comparison-first-failure.png',fullPage:true});throw e;} finally {await browser.close();}
