const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.type(), msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url(), request.failure().errorText));

  console.log('Navigating to http://localhost:5173...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 10000 }).catch(e => console.log('Goto error:', e.message));
  
  const bodyHTML = await page.evaluate(() => document.body.innerHTML);
  console.log('Body length:', bodyHTML.length);
  if (bodyHTML.length < 200) {
     console.log('Body preview:', bodyHTML);
  }
  
  await browser.close();
})();
