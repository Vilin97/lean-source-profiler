// Run with Playwright installed against a viewer serving the two source fixtures.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const base=process.argv[2], browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
 const page=await browser.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto(base); await page.waitForSelector('.timing-table');
  const folder=page.locator('.entry-name').filter({has:page.locator('.entry-icon.folder')}).first();
  if(await folder.count())await folder.click();
  const session=await page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  const index=await page.evaluate(()=>fetch('/api/index').then(r=>r.json()));
  assert.equal(session.status,'complete');assert.equal(session.files.length,2);
  assert.equal(index.filter(r=>r.kind==='file').length,2);
  await page.getByRole('button',{name:'Declarations',exact:true}).click();
  await page.getByRole('button',{name:/SourceProfileFixtures.twoTactics/}).click();
  await page.waitForSelector('#source-panel .source-line.has-timing');
  assert.match(await page.locator('#detail-panel').innerText(),/Declaration breakdown/);
  assert.match(await page.locator('#stats').innerText(),/source-focused/);
  await page.locator('#source-panel .source-line.has-timing').first().click();
  await page.waitForFunction(()=>document.querySelector('#detail-panel')?.textContent.includes('Source-focused capture.'));
  assert.equal(await page.locator('details.expression,.definition-link').count(),0);
  assert(await page.locator('.source-line.highlighted').count()>0);
  await page.locator('#breadcrumbs button').first().click();
  await page.getByRole('button',{name:'Tactics',exact:true}).click();
  await page.locator('input.search').fill('exact Eq.refl x');
  await page.locator('.entry-name').first().click();
  await page.waitForSelector('#source-panel .source-line.highlighted');
  assert.match(await page.locator('#detail-panel').innerText(),/Tactic breakdown/);
  assert.match(await page.locator('#source-panel').innerText(),/exact Eq.refl x/);
  const file=session.files.find(f=>f.path.endsWith('Accuracy.lean'));
  const p=await page.evaluate(id=>fetch('/api/file?id='+id).then(r=>r.json()),file.id);
  assert.equal(p.captureMode,'compact');assert.equal(p.sourceClock,'CLOCK_MONOTONIC_RAW');
  assert.match(p.clockSha256,/^[a-f0-9]{64}$/);
  for(const n of p.nodes)assert(Number.isFinite(n.durationMs)&&n.durationMs>=0);
  assert.deepEqual(errors,[]);
  console.log('PASS browser: session/folder, declaration and tactic drill-down, source bars, compact mode disclosure, metadata and no JS errors.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
