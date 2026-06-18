import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto('http://localhost:5173/', { waitUntil:'networkidle2', timeout:60000 });
await sleep(800);
await (await page.$('#file-a')).uploadFile('C:/Cut up splatting/Raspberry.sog'); await sleep(4000);
await (await page.$('#file-b')).uploadFile('C:/Cut up splatting/Raspberry.sog'); await sleep(9000);
const setCross = (v)=>page.evaluate(v=>{const c=document.querySelector('#crossfader');c.value=String(v);c.dispatchEvent(new Event('input',{bubbles:true}));},v);
// Sample repeatedly until both decks stable, capture overlay opacity.
const sampleStable = async (target)=>{
  await setCross(target);
  let last=null;
  for(let i=0;i<20;i++){
    await sleep(300);
    const s = await page.evaluate(()=>({loaded:(window.viewer&&window.viewer.splatMesh)?window.viewer.splatMesh.getSceneCount():0, ov:{...window._lastOverlayOpacity}}));
    last=s;
    if(s.loaded>5) break; // both decks present (each ~5-13 chunks)
  }
  return last;
};
const c0 = await sampleStable(0); console.log('c0', JSON.stringify(c0));
const c100 = await sampleStable(100); console.log('c100', JSON.stringify(c100));
await browser.close();
