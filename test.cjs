const puppeteer = require('puppeteer');

(async () => {
  console.log("Launching browser...");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Forward console logs from the page
  page.on('console', msg => {
    const text = msg.text();
    // Ignore some common noisy Vite logs
    if (!text.includes('[vite]')) {
      console.log('PAGE LOG:', text);
    }
  });

  page.on('pageerror', err => {
    console.log('PAGE ERROR:', err.toString());
  });

  console.log("Navigating to http://localhost:5173/...");
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 30000 });
  
  console.log("Taking initial screenshot...");
  await page.screenshot({ path: 'screenshot1_initial.png' });
  
  console.log("Done.");
  await browser.close();
})();
