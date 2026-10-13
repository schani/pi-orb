import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';

const url = process.env.STUDY_URL || pathToFileURL(new URL('./token-usage-refinements.html', import.meta.url).pathname).href;
const browser = await chromium.launch({ executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const sum = rows => rows.reduce((a,r) => {
  a.calls++;
  for (const key of ['input','output','cache_read','cache_write']) a[key] += r[key];
  return a;
}, { input:0, output:0, cache_read:0, cache_write:0, calls:0 });
const overflow = async label => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ' overflows');
async function checkData() {
  const state = await page.evaluate(() => window.usageStudy.state());
  const totals = sum(state.rows);
  const displayed = await page.locator('[data-summary]').evaluateAll(ns => ns.map(n => [n.dataset.summary, Number(n.dataset.value)]));
  for (const [key,value] of displayed) {
    if (key === 'total') assert.equal(value, totals.input+totals.output+totals.cache_read+totals.cache_write);
    else if (key === 'share') {
      const p=totals.input+totals.cache_read+totals.cache_write;
      assert.equal(value,p?totals.cache_read/p:0);
    } else assert.equal(value,totals[key]);
  }
  assert.ok(state.rows.every(r => r.at >= state.start && r.at < state.end), 'period bounds');
  assert.equal(state.buckets.reduce((s,b)=>s+b.values.reduce((n,v)=>n+v,0),0),totals.input+totals.output+totals.cache_read+totals.cache_write, 'time series reconciles');
  const painted = await page.locator('[data-bucket-total]').evaluateAll(ns=>ns.map(n=>Number(n.dataset.bucketTotal)));
  assert.deepEqual(painted,state.buckets.map(b=>b.values.reduce((n,v)=>n+v,0)),'drawn time buckets match values');
  const measure = await page.locator('[data-ranking]').inputValue();
  for (const kind of ['orbs','uses']) {
    const displayedBars=await page.locator('[data-bars="'+kind+'"] [data-bar-value]').evaluateAll(ns=>ns.map(n=>Number(n.dataset.barValue)));
    assert.deepEqual(displayedBars,[...displayedBars].sort((a,b)=>b-a),kind+' ranked descending');
    const grouped={};
    for(const row of state.rows) {
      const key=kind==='orbs'?row.orb_id:row.use;
      grouped[key]=(grouped[key]||0)+(measure==='total'?row.input+row.output+row.cache_read+row.cache_write:row[measure]);
    }
    const expected=Object.values(grouped).sort((a,b)=>b-a).slice(0,kind==='orbs'?5:6);
    assert.deepEqual(displayedBars,expected,kind+' values match aggregation');
  }
  return state;
}
try {
  await page.goto(url);
  await page.evaluate(()=>document.fonts.ready);
  assert.ok(await page.evaluate(()=>[...document.fonts].some(f=>f.family.includes('Iosevka Etoile')&&f.status==='loaded')));
  assert.equal(await page.locator('[data-layout]').count(),5);
  assert.equal(await page.locator('[data-icon]').count(),5);
  for (const icon of ['bars','trend','gauge','layers','sum']) {
    await page.locator('[data-icon="'+icon+'"]').click();
    assert.equal(await page.locator('[data-access] svg').getAttribute('data-selected-icon'),icon);
    assert.equal(await page.locator('[data-access]').innerText(),'','product entry is icon only');
  }
  for (let layout=1;layout<=5;layout++) {
    await page.locator('[data-layout="'+layout+'"]').click();
    await page.locator('[data-access]').focus();
    await page.keyboard.press('Enter');
    assert.ok(await page.locator('[data-display]').isVisible());
    assert.equal(await page.locator('[data-period]').count(),4);
    const counts=[];
    for(const period of ['day','week','month','6months']) {
      await page.locator('[data-period="'+period+'"]').click();
      const state=await checkData();
      counts.push(state.rows.length);
      assert.equal(state.buckets.length,period==='day'?24:period==='week'?7:period==='month'?30:27);
      for(const split of ['tokens','use','model']) {
        await page.locator('[data-breakdown]').selectOption(split);
        const s=await checkData();
        assert.equal(s.buckets[0].values.length,s.series.length);
        assert.ok(await page.locator('[data-series-chart]').count()>=1);
      }
    }
    assert.ok(counts.every((n,i)=>i===0||n>counts[i-1]),'larger periods include more rows');
    for(const metric of ['total','input','output']) {
      await page.locator('[data-ranking]').selectOption(metric);
      await checkData();
    }
    await page.locator('[data-bucket]').first().focus();
    await page.keyboard.press('Enter');
    assert.ok(await page.locator('[data-bucket-detail]').isVisible());
    await page.locator('[data-coverage]').click();
    assert.ok(await page.locator('[data-coverage-dialog]').isVisible());
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('[data-display]').isVisible(),'coverage Escape keeps display');
    await page.locator('[data-back]').click();
    assert.ok(await page.locator('[data-access]').evaluate(el=>el===document.activeElement));
  }
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    for(let layout=1;layout<=5;layout++) {
      await page.locator('[data-layout="'+layout+'"]').click();
      await overflow('dashboard '+layout+'/'+width);
      await page.locator('[data-access]').click();
      await page.locator('[data-period="month"]').click();
      await page.locator('[data-breakdown]').selectOption(layout===3?'model':layout===5?'tokens':'use');
      await overflow('display '+layout+'/'+width);
      if(width<600) {
        const small=await page.locator('button:visible, select:visible, summary:visible').evaluateAll(ns=>ns.filter(n=>n.getBoundingClientRect().height<44).map(n=>n.outerHTML.slice(0,150)));
        assert.deepEqual(small,[],'phone targets');
        assert.ok(await page.locator('select:visible').evaluateAll(ns=>ns.every(n=>parseFloat(getComputedStyle(n).fontSize)>=16)));
      }
      await page.screenshot({path:'/tmp/token-usage-refinements-'+layout+'-'+width+'.png',fullPage:true});
      await page.keyboard.press('Escape');
      assert.ok(await page.locator('[data-dashboard]').isVisible());
    }
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: five icons and layouts; four periods; token/use/model series; reconciled summary/series/rankings; bucket details; keyboard and focus; 1440/390/320 containment and phone targets.');
} catch(error) {
  writeFileSync('/tmp/token-usage-refinements-first-failure.txt',String(error.stack));
  await page.screenshot({path:'/tmp/token-usage-refinements-first-failure.png',fullPage:true});
  throw error;
} finally {await browser.close();}
