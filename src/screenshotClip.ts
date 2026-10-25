/**
 * Clip rectangle for a capped (maxWidth) CDP screenshot.
 *
 * `Page.captureScreenshot` takes its `clip` in PAGE coordinates, not viewport
 * coordinates. `{x:0, y:0}` after the page has scrolled names the top of the
 * document, which lies outside the viewport, and without captureBeyondViewport
 * Chrome returns a flat background-coloured frame — the "blank screenshot after
 * a scroll" the MCP browser_screenshot tool produced on 2026-09-12 (9.7 KB of
 * one colour at scrollY 2045, while the same clip offset by the scroll was
 * 39 KB of page). Offset the clip by the current scroll so a capped capture
 * always shows what is on screen.
 */
export interface ViewportMetrics {
  w: number;
  h: number;
  dpr?: number;
  sx?: number;
  sy?: number;
}

export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export function viewportClip(vp: ViewportMetrics, scale: number): ScreenshotClip {
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    x: Math.max(0, num(vp.sx)),
    y: Math.max(0, num(vp.sy)),
    width: vp.w,
    height: vp.h,
    scale,
  };
}
