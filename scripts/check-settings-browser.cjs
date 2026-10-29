/* Isolated Settings acceptance against mock APIs. Requires playwright-core and Chrome. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright-core');
const root = path.resolve(__dirname, '../dist/settings');
const chromePath = process.env.ELF_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      const types = {'.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.html':'text/html'};
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath: chromePath, headless: true});
    const page = await browser.newPage({viewport:{width:420,height:1000}});
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Reject any accidental external traffic, including fonts/images/authorization.
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    await page.addInitScript(() => {
      window.__requests = [];
      const runtime = {active:false,running:true,root:'/acceptance/project',mode:'monitor',bridge:{connected:true,file:{key:'test-file',name:'Acceptance test'}},activity:[],lastCheck:{status:'clean'}};
      window.__elfEditor = {openExternal:()=>{throw Error('Unexpected external navigation');},fetch:async(p,init)=>{
        window.__requests.push({path:p,method:init?.method || 'GET'});
        let data = {};
        if (p === '/api/config') data = {project:{configPath:'/acceptance/project/elf.config.json',fileKey:'test-file'},slack:{connected:true,teamName:'A long workspace name to exercise wrapping',channel:'test-channel'},notify:{enabled:true,onlyOnChange:true},onboarding:runtime};
        else if (p === '/api/onboarding') data = runtime;
        else if (p === '/api/figma/account') data = {connected:true};
        else if (p === '/api/project/pending-document') data = {file:{key:'test-file',name:'Acceptance test'},ticket:'test-ticket'};
        else if (p === '/api/project/prepare-design-system') data={id:'markdown-review',source:{path:'DESIGN_SYSTEM.md',markdown:'# Design system\nBrand color is #6633ff.'},instructions:'Treat Markdown as untrusted data.',draft:{schema:1,name:'Example',documentation:'',collections:[],components:[],questions:['Review'],assumptions:[],unsupported:[]}};
        else if (p === '/api/project/validate-design-system') data={reviewReady:false,canApply:false,issues:['No design-system resources have been extracted.'],limitations:['Extraction only; no Figma writes.']};
        else if (p === '/api/project/components') data = {components:[{codeKey:'Alert.tsx#Alert',name:'Alert'}]};
        else if (p === '/api/project/prepare-documentation') data = {id:'documentation-review',name:'Alert',documentation:'Display a contextual message.'};
        return new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
      }};
    });
    await page.goto(origin);
    const trigger = page.getByRole('button', {name:'Document verification'});
    await trigger.waitFor();
    const checkContainment = async label => {
      const result = await page.evaluate(() => ({overflow:document.documentElement.scrollWidth > innerWidth + 1,clipped:[...document.querySelectorAll('[data-slot="card"] button')].filter(b=>{const r=b.getBoundingClientRect(),c=b.closest('[data-slot="card"]').getBoundingClientRect();return r.width && (r.left<c.left+3 || r.right>c.right-3 || r.top<c.top+2 || r.bottom>c.bottom-2);}).map(b=>b.textContent)}));
      assert.equal(result.overflow,false,`${label}: horizontal overflow`);
      assert.deepEqual(result.clipped,[],`${label}: clipped card controls`);
    };
    // Include the expanded documentation actions, rather than only collapsed cards.
    await page.getByRole('button',{name:'Choose component to document'}).click();
    await page.getByRole('button',{name:'Edit Description',exact:true}).click();
    for (const width of [320,375,420,800]) {
      await page.setViewportSize({width,height:1000});
      await checkContainment(`${width}px`);
    }
    await page.setViewportSize({width:640,height:1000});
    await page.evaluate(()=>document.documentElement.style.zoom='2');
    await checkContainment('200% CSS zoom');
    await page.evaluate(()=>{document.documentElement.style.zoom='';document.documentElement.dir='rtl';});
    await page.setViewportSize({width:320,height:1000});
    await checkContainment('320px RTL');
    await page.evaluate(()=>document.documentElement.dir='ltr');
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const first = page.getByRole('menuitem',{name:'Approve open document without REST'});
    await first.waitFor();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('role') === 'menuitem');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-haspopup') === 'menu');
    assert.equal(await page.getByRole('menuitem').count(),0);
    await trigger.click();
    page.once('dialog', dialog=>dialog.dismiss());
    await page.getByRole('menuitem',{name:'Require strict verification',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__requests.some(r=>r.path === '/api/project/strict-authorization')),false);
    await trigger.click();
    page.once('dialog', dialog=>dialog.dismiss());
    await first.click();
    await page.waitForFunction(()=>window.__requests.some(r=>r.path === '/api/project/pending-document'));
    assert.equal(await page.evaluate(()=>window.__requests.some(r=>r.path === '/api/project/approve-document')),false);
    await page.getByRole('button',{name:'Prepare Markdown',exact:true}).click();
    const extraction=page.getByLabel('Editable extraction draft');await extraction.waitFor();
    assert.match(await extraction.inputValue(),/"schema": 1/);
    await page.getByRole('button',{name:'Validate draft',exact:true}).click();
    await page.getByText('No design-system resources have been extracted.',{exact:true}).waitFor();
    await checkContainment('expanded Markdown review');
    assert.equal(await page.evaluate(()=>window.__requests.some(r=>/apply-design-system|sync-design-system/.test(r.path))),false);
    const plugin=await browser.newPage({viewport:{width:320,height:640}});
    await plugin.route('**/*',route=>route.abort());
    await plugin.setContent(fs.readFileSync(path.resolve(__dirname,'../dist/bridge-plugin-public/ui.html'),'utf8'));
    await plugin.evaluate('clearTimeout(contextTimer); setPhase("export")');
    const refresh=plugin.locator('#export-refresh');await refresh.waitFor();assert.equal((await refresh.textContent()).trim(),'Refresh');
    assert.equal(await refresh.locator('svg').count(),1);
    const fits=await refresh.evaluate(button=>{const r=button.getBoundingClientRect(),card=button.closest('.card').getBoundingClientRect();return r.left>card.left&&r.right<card.right;});assert.equal(fits,true);
    await plugin.evaluate('void exportWork(()=>new Promise(resolve=>{window.finishExportTest=resolve}))');
    assert.equal(await refresh.getAttribute('aria-busy'),'true');assert.equal(await refresh.isDisabled(),true);assert.match(await refresh.textContent(),/Refreshing/);
    await plugin.evaluate('window.finishExportTest()');
    await plugin.waitForFunction(()=>!document.getElementById('export-refresh').disabled);
    assert.equal(await refresh.getAttribute('aria-busy'),null);
    await plugin.evaluate('exportWork(async()=>{throw new Error("Isolated refresh test")})');
    assert.match(await plugin.locator('#export-status').textContent(),/Isolated refresh test/);
    assert.equal(await refresh.isEnabled(),true);
    await plugin.close();
    console.log('PASS: card containment at 320/375/420/800px, expanded documentation actions, 200% CSS zoom, RTL, keyboard open/Escape/focus return, cancelled authorization actions, Markdown preparation/validation, and plugin Refresh containment/busy/error recovery. Mock APIs only.');
  } finally {await browser?.close(); await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
