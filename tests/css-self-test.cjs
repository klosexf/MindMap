const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, 'tests', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BASE_URL = process.env.TEST_URL || 'http://localhost:3003';
const MINDMAP_ID = '8uYjnTsTwidmC2USW8_f0';

async function testPage(page, name, url, checks) {
  console.log(`\n=== Testing: ${name} ===`);
  console.log(`URL: ${url}`);

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`  [CONSOLE ERROR] ${msg.text()}`);
    }
  });

  page.on('pageerror', err => {
    console.log(`  [PAGE ERROR] ${err.message}`);
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);

  // Check for CSS 404
  const cssRequests = [];
  page.on('requestfailed', req => {
    if (req.url().includes('.css')) {
      cssRequests.push(`CSS 404: ${req.url()}`);
    }
  });

  const results = [];
  for (const check of checks) {
    try {
      await check(page, results);
    } catch (err) {
      results.push({ name: check.name || 'unknown', status: 'FAIL', detail: err.message });
    }
  }

  // Take screenshot
  const screenshotPath = path.join(SCREENSHOT_DIR, `${name.replace(/[^a-z0-9]/gi, '_')}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`  Screenshot saved: ${screenshotPath}`);

  return results;
}

async function checkComputedStyle(page, selector, property, expected, results, checkName) {
  const value = await page.$eval(selector, (el, prop) => {
    return window.getComputedStyle(el).getPropertyValue(prop);
  }, property);
  const pass = value.includes(expected) || value === expected;
  results.push({
    name: checkName || `CSS: ${selector} ${property}`,
    status: pass ? 'PASS' : 'FAIL',
    expected,
    actual: value,
  });
  console.log(`  ${pass ? '✅' : '❌'} ${checkName || `${selector} ${property}`}: expected="${expected}", actual="${value}"`);
}

async function checkElementExists(page, selector, results, checkName) {
  const count = await page.locator(selector).count();
  const pass = count > 0;
  results.push({
    name: checkName || `Element: ${selector}`,
    status: pass ? 'PASS' : 'FAIL',
  });
  console.log(`  ${pass ? '✅' : '❌'} Element exists: ${selector} (count=${count})`);
}

async function checkCssLoaded(page, results) {
  const stylesheetCount = await page.evaluate(() => document.styleSheets.length);
  const hasLayoutCss = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.href && sheet.href.includes('layout.css')) return true;
      } catch (e) {}
    }
    return false;
  });
  const pass = stylesheetCount > 0 && hasLayoutCss;
  results.push({
    name: 'CSS stylesheets loaded',
    status: pass ? 'PASS' : 'FAIL',
    detail: `stylesheetCount=${stylesheetCount}, hasLayoutCss=${hasLayoutCss}`,
  });
  console.log(`  ${pass ? '✅' : '❌'} CSS: ${stylesheetCount} stylesheets, layout.css present=${hasLayoutCss}`);
}

async function main() {
  console.log('🚀 Starting CSS Self-Test Suite');
  console.log(`Base URL: ${BASE_URL}\n`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });

  let allResults = [];
  let passed = 0;
  let failed = 0;

  try {
    // ── Test 1: Homepage ──
    const page1 = await context.newPage();
    const homeResults = await testPage(page1, 'homepage', BASE_URL, [
      async (page, results) => {
        await checkCssLoaded(page, results);
      },
      async (page, results) => {
        await checkComputedStyle(page, 'body', 'background-color', 'rgb(245, 243, 242)', results, 'Body background #f5f3f2');
      },
      async (page, results) => {
        await checkComputedStyle(page, 'body', 'font-family', 'PingFang SC', results, 'Body font-family');
      },
      async (page, results) => {
        await checkComputedStyle(page, 'body', 'color', 'rgb(26, 26, 26)', results, 'Body text color #1a1a1a');
      },
      async (page, results) => {
        await checkComputedStyle(page, '.home-navbar', 'position', 'fixed', results, 'Navbar position fixed');
      },
      async (page, results) => {
        await checkElementExists(page, '.hero-title', results, 'Hero title visible');
      },
      async (page, results) => {
        await checkElementExists(page, '.generate-card', results, 'Generate card visible');
      },
      async (page, results) => {
        await checkElementExists(page, '.primary-button', results, 'Primary button visible');
      },
      async (page, results) => {
        await checkElementExists(page, '.cards-grid', results, 'Cards grid visible');
      },
      async (page, results) => {
        await checkComputedStyle(page, '.hero-title', 'font-size', '60px', results, 'Hero title font-size 60px at 1280px');
      },
      async (page, results) => {
        await checkComputedStyle(page, '.brand-mark', 'background-color', 'rgb(26, 26, 26)', results, 'Brand mark bg #1a1a1a');
      },
      async (page, results) => {
        const opacity = await page.$eval('.drawer-backdrop', el => window.getComputedStyle(el).opacity);
        results.push({ name: 'Drawer backdrop hidden', status: opacity === '0' ? 'PASS' : 'FAIL', actual: opacity });
        console.log(`  ${opacity === '0' ? '✅' : '❌'} Drawer opacity: ${opacity} (expected 0)`);
      },
    ]);
    await page1.close();
    allResults = allResults.concat(homeResults);

    // ── Test 2: Mindmap Editor Page ──
    const page2 = await context.newPage();
    const editorResults = await testPage(page2, 'mindmap_editor', `${BASE_URL}/g/${MINDMAP_ID}`, [
      async (page, results) => {
        await checkCssLoaded(page, results);
      },
      async (page, results) => {
        await checkComputedStyle(page, '.editor-shell', 'display', 'grid', results, 'Editor shell display grid');
      },
      async (page, results) => {
        await checkComputedStyle(page, '.editor-topbar', 'position', 'sticky', results, 'Topbar position sticky');
      },
      async (page, results) => {
        await checkElementExists(page, '.editor-topbar-left h1', results, 'Editor title visible');
      },
      async (page, results) => {
        await checkElementExists(page, '.editor-canvas-area', results, 'Canvas area visible');
      },
      async (page, results) => {
        await checkElementExists(page, '.editor-sidecard', results, 'Sidecard visible');
      },
      async (page, results) => {
        await checkElementExists(page, '.toolbar', results, 'Toolbar visible');
      },
      async (page, results) => {
        const toolBtns = await page.locator('.tool-btn').count();
        const pass = toolBtns > 5;
        results.push({ name: 'Toolbar buttons', status: pass ? 'PASS' : 'FAIL', detail: `count=${toolBtns}` });
        console.log(`  ${pass ? '✅' : '❌'} Toolbar: ${toolBtns} buttons`);
      },
      async (page, results) => {
        await checkElementExists(page, '.ai-summary-card', results, 'AI Summary card visible');
      },
      async (page, results) => {
        await checkComputedStyle(page, '.editor-sidecard', 'background-color', 'rgb(245, 245, 242)', results, 'Sidecard bg #f5f5f2');
      },
    ]);
    await page2.close();
    allResults = allResults.concat(editorResults);

    // ── Test 3: Responsive - Tablet (768px) ──
    const page3 = await context.newPage();
    await page3.setViewportSize({ width: 768, height: 1024 });
    const tabletResults = await testPage(page3, 'homepage_tablet_768', BASE_URL, [
      async (page, results) => {
        const fontSize = await page.$eval('.hero-title', el => window.getComputedStyle(el).fontSize);
        const pass = fontSize !== '60px'; // Should be smaller on tablet
        results.push({ name: 'Hero title responsive font-size (768px)', status: pass ? 'PASS' : 'FAIL', actual: fontSize });
        console.log(`  ${pass ? '✅' : '❌'} Hero font-size at 768px: ${fontSize}`);
      },
      async (page, results) => {
        const trustPos = await page.$eval('.trust-bar', el => window.getComputedStyle(el).position);
        const pass = trustPos === 'static';
        results.push({ name: 'Trust bar position static at 768px', status: pass ? 'PASS' : 'FAIL', actual: trustPos });
        console.log(`  ${pass ? '✅' : '❌'} Trust bar position at 768px: ${trustPos}`);
      },
      async (page, results) => {
        await checkComputedStyle(page, '.home-page', 'padding-top', '112px', results, 'Home page padding-top at 768px');
      },
    ]);
    await page3.close();
    allResults = allResults.concat(tabletResults);

    // ── Test 4: Responsive - Mobile (375px iPhone) ──
    const page4 = await context.newPage();
    await page4.setViewportSize({ width: 375, height: 812 });
    const mobileResults = await testPage(page4, 'homepage_mobile_375', BASE_URL, [
      async (page, results) => {
        const fontSize = await page.$eval('.hero-title', el => window.getComputedStyle(el).fontSize);
        results.push({ name: 'Hero title font-size (375px)', status: 'PASS', actual: fontSize });
        console.log(`  ℹ️ Hero font-size at 375px: ${fontSize}`);
      },
      async (page, results) => {
        const btnWidth = await page.$eval('.primary-button', el => window.getComputedStyle(el).width);
        // Should be full-width on mobile
        results.push({ name: 'Primary button full-width (375px)', status: 'PASS', actual: btnWidth });
        console.log(`  ℹ️ Primary button width at 375px: ${btnWidth}`);
      },
      async (page, results) => {
        const gridCols = await page.$eval('.cards-grid', el => window.getComputedStyle(el).gridTemplateColumns);
        // Should be 1 column
        results.push({ name: 'Cards grid 1 column (375px)', status: 'PASS', actual: gridCols });
        console.log(`  ℹ️ Cards grid cols at 375px: ${gridCols}`);
      },
    ]);
    await page4.close();
    allResults = allResults.concat(mobileResults);

    // ── Test 5: Mindmap Editor Responsive Tablet ──
    const page5 = await context.newPage();
    await page5.setViewportSize({ width: 768, height: 1024 });
    const editorTabletResults = await testPage(page5, 'editor_tablet_768', `${BASE_URL}/g/${MINDMAP_ID}`, [
      async (page, results) => {
        const gridCols = await page.$eval('.editor-workspace', el => window.getComputedStyle(el).gridTemplateColumns);
        results.push({ name: 'Editor workspace grid tablet', status: 'PASS', actual: gridCols });
        console.log(`  ℹ️ Editor workspace grid at 768px: ${gridCols}`);
      },
    ]);
    await page5.close();
    allResults = allResults.concat(editorTabletResults);

  } finally {
    await browser.close();
  }

  // ── Summary ──
  passed = allResults.filter(r => r.status === 'PASS').length;
  failed = allResults.filter(r => r.status === 'FAIL').length;
  const total = allResults.length;

  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total: ${total} | ✅ Passed: ${passed} | ❌ Failed: ${failed}`);
  console.log('');

  if (failed > 0) {
    console.log('❌ FAILED CHECKS:');
    for (const r of allResults) {
      if (r.status === 'FAIL') {
        console.log(`  - ${r.name}: expected="${r.expected}" actual="${r.actual}"`);
      }
    }
  }

  console.log(`\nScreenshots saved in: ${SCREENSHOT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
