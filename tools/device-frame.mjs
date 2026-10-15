// Shared helpers for the README and site images: a phone-shaped browser context with realistic safe areas, and a flat,
// self-drawn modern iPhone-style frame around a screenshot (no Apple artwork: plain shapes only).
//
//   import { newPhoneContext, framePhone } from './device-frame.mjs';
//
// The screen is 402 x 874 CSS px (the size of the current Pro-size iPhones). iOS reserves 54 px at the top (status bar and
// Dynamic Island) and 34 px at the bottom (home indicator); a headless browser reports 0 for both, so the context rewrites
// `env(safe-area-inset-*)` in the app stylesheet to those values and the frame draws the status bar and the home indicator
// over the reserved areas.
export const SCREEN = { width: 402, height: 874 };
export const SAFE = { top: 54, bottom: 34 };

/** Browser context that looks like a Pro-size iPhone, including the safe areas. */
export async function newPhoneContext(browser, devices, { scheme = 'light', locale = 'en-US', storageState } = {}) {
  const ctx = await browser.newContext({
    ...devices['iPhone 14'],
    viewport: { width: SCREEN.width, height: SCREEN.height },
    screen: { width: SCREEN.width, height: SCREEN.height },
    deviceScaleFactor: 2,
    locale,
    colorScheme: scheme,
    ...(storageState ? { storageState } : {}),
  });
  await ctx.route(/\/css\/app\.css(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const css = (await res.text()).replaceAll('env(safe-area-inset-top)', `${SAFE.top}px`).replaceAll('env(safe-area-inset-bottom)', `${SAFE.bottom}px`);
    await route.fulfill({ response: res, body: css });
  });
  return ctx;
}

const STATUS_ICONS = (color) => `
  <svg width="18" height="12" viewBox="0 0 18 12" fill="${color}" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
  <svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M1.5 4.2a10 10 0 0 1 14 0"/><path d="M4 7a6.4 6.4 0 0 1 9 0"/><circle cx="8.5" cy="10" r="1" fill="${color}" stroke="none"/></svg>
  <svg width="27" height="13" viewBox="0 0 27 13" aria-hidden="true"><rect x="0.5" y="0.5" width="23" height="12" rx="3.8" fill="none" stroke="${color}" opacity="0.4"/><rect x="2" y="2" width="20" height="9" rx="2.6" fill="${color}"/><path d="M25 4.5v4" stroke="${color}" stroke-width="1.6" stroke-linecap="round" opacity="0.5"/></svg>`;

/**
 * Wraps a screenshot (PNG file of the screen, taken with `newPhoneContext`) in the phone frame and writes a PNG with a
 * transparent background.
 */
export async function framePhone(browser, { src, out, scheme = 'light', fs }) {
  const ink = scheme === 'dark' ? '#ffffff' : '#000000';
  const uri = `data:image/png;base64,${fs.readFileSync(src).toString('base64')}`;
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
  <div id="phone" style="position:relative;width:${SCREEN.width + 24 + 8}px;height:${SCREEN.height + 24}px;padding:0 4px;box-sizing:content-box">
    <!-- side buttons -->
    <div style="position:absolute;left:1px;top:132px;width:3px;height:30px;background:#575b62;border-radius:2px 0 0 2px"></div>
    <div style="position:absolute;left:1px;top:196px;width:3px;height:56px;background:#575b62;border-radius:2px 0 0 2px"></div>
    <div style="position:absolute;left:1px;top:266px;width:3px;height:56px;background:#575b62;border-radius:2px 0 0 2px"></div>
    <div style="position:absolute;right:1px;top:226px;width:3px;height:92px;background:#575b62;border-radius:0 2px 2px 0"></div>
    <!-- metal frame, then the black glass border, then the screen -->
    <div style="position:absolute;left:4px;top:0;width:${SCREEN.width + 24}px;height:${SCREEN.height + 24}px;box-sizing:border-box;background:#575b62;border-radius:68px;padding:3px">
      <div style="width:100%;height:100%;box-sizing:border-box;background:#000;border-radius:65px;padding:9px">
        <div style="position:relative;width:${SCREEN.width}px;height:${SCREEN.height}px;border-radius:56px;overflow:hidden;background:#000">
          <img src="${uri}" width="${SCREEN.width}" height="${SCREEN.height}" style="display:block">
          <!-- status bar -->
          <div style="position:absolute;left:0;right:0;top:0;height:${SAFE.top}px;font:600 17px/1 -apple-system,'SF Pro Text',Helvetica,Arial,sans-serif;color:${ink}">
            <div style="position:absolute;left:0;width:134px;top:21px;text-align:center;letter-spacing:0.2px">9:41</div>
            <div style="position:absolute;right:0;width:134px;top:21px;display:flex;gap:6px;align-items:center;justify-content:center">${STATUS_ICONS(ink)}</div>
          </div>
          <!-- Dynamic Island -->
          <div style="position:absolute;left:50%;top:11px;width:124px;height:36px;margin-left:-62px;background:#000;border-radius:18px"></div>
          <!-- home indicator -->
          <div style="position:absolute;left:50%;bottom:8px;width:136px;height:5px;margin-left:-68px;background:${ink};border-radius:3px;opacity:0.9"></div>
        </div>
      </div>
    </div>
  </div></body></html>`;
  const ctx = await browser.newContext({ viewport: { width: SCREEN.width + 40, height: SCREEN.height + 40 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.evaluate(() => document.fonts?.ready);
  await page.locator('#phone').screenshot({ path: out, omitBackground: true });
  await ctx.close();
}
