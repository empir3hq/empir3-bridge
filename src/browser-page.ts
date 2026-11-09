export const PAGE_READINESS_EXPRESSION = 'JSON.stringify({body:!!document.body,readyState:document.readyState,visible:document.visibilityState!=="hidden"})';

/** A cold navigation can have a CDP context before it has a DOM body. */
export async function waitForBrowserPage(probe: (timeoutMs: number) => Promise<any>, opts: any = {}): Promise<any> {
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const deadline = now() + (opts.timeoutMs ?? 5000);
  do {
    let state: any;
    try {state = await probe(Math.max(1, Math.min(750, deadline-now())));} catch(error: any) {
      if (!/timeout|context.*destroyed|Cannot find context|navigat/i.test(String(error?.message))) throw error;
    }
    if (typeof state === 'string') {try {state=JSON.parse(state);} catch {state=null;}}
    if (opts.requireVisible && state?.visible === false) return {success:false,verified:false,code:'browser_tab_not_visible',error:'The agent tab is hidden. Use browser_tab_focus action "control", then observe again.',inputMayHaveOccurred:false};
    if (state?.body && ['interactive','complete'].includes(state.readyState)) return {success:true,verified:true};
    if (now() >= deadline) break;
    await sleep(Math.min(100, deadline-now()));
  } while (now() < deadline);
  return {success:false,verified:false,code:'page_loading',error:'The page is still loading. Wait, then take a fresh browser_snapshot.',inputMayHaveOccurred:false};
}
