/**
 * Reliability-smoke trusted-click check, in a scratch tab (Work Board 533bec00).
 *
 * The check used to navigate the LIVE tab to a data: page, click it, and
 * navigate back. The URL came back; the page state did not — it wiped a
 * completed Accuracy Lab run seconds after it finished. Any unsaved in-page
 * state (a filled form, an in-progress run, an open editor) was lost with no
 * warning.
 *
 * Now the check opens its own tab, runs there, closes it, and re-activates
 * whatever tab was current before. The original tab is never navigated. The
 * orchestration is a pure function over an adapter so the ordering guarantee
 * (never navigate the caller's tab; always restore it) is pinned by tests.
 */

'use strict';

const CLICK_TEST_HTML = '<!doctype html><html><body style="margin:0;font-family:sans-serif"><button id="target" style="position:absolute;left:100px;top:100px;width:220px;height:80px;font-size:22px">Trusted click target</button><div id="result" style="position:absolute;left:100px;top:210px;font-size:24px">waiting</div><script>document.getElementById("target").addEventListener("click",e=>{document.getElementById("result").textContent=e.isTrusted?"trusted coordinate click":"synthetic click"})</script></body></html>';
const CLICK_TEST_URL = `data:text/html;charset=utf-8,${encodeURIComponent(CLICK_TEST_HTML)}`;
const EXPECTED_RESULT = 'trusted coordinate click';

/**
 * @param {object} adapter
 * @param {() => Promise<string>} adapter.currentTargetId   tab the user/agent is on right now
 * @param {(url:string) => Promise<string>} adapter.createTab  opens a tab (becomes current), returns its targetId
 * @param {(x:number,y:number) => Promise<void>} adapter.click  native coordinate click on the current tab
 * @param {(expression:string) => Promise<any>} adapter.evaluate
 * @param {(targetId:string) => Promise<void>} adapter.closeTab
 * @param {(targetId:string) => Promise<void>} adapter.activate  make a tab current again
 * @param {(ms:number) => Promise<void>} [adapter.sleep]
 * @returns {Promise<{ok:boolean, detail:any}>}
 */
async function runTrustedClickCheck(adapter) {
  const sleep = adapter.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let previous = '';
  try { previous = String((await adapter.currentTargetId()) || ''); } catch { previous = ''; }
  let scratch = '';
  let ok = false;
  let detail;
  try {
    scratch = String(await adapter.createTab(CLICK_TEST_URL));
    if (!scratch) throw new Error('scratch tab was not created');
    await sleep(600);
    await adapter.click(210, 140);
    const raw = await adapter.evaluate("document.getElementById('result')?.textContent");
    const text = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
    ok = text === EXPECTED_RESULT;
    detail = { scratchTab: scratch, result: text, restoredTab: previous || null };
  } catch (error) {
    ok = false;
    detail = { scratchTab: scratch || null, error: error?.message || String(error), restoredTab: previous || null };
  } finally {
    // Close the scratch tab first, then hand the bridge back to the tab it was
    // on. Both are best-effort: the check's verdict must not depend on them,
    // but a failure to restore is reported so it is never silent.
    if (scratch) {
      try { await adapter.closeTab(scratch); } catch (error) { detail = { ...detail, closeError: error?.message || String(error) }; }
    }
    if (previous && previous !== scratch) {
      try { await adapter.activate(previous); } catch (error) { detail = { ...detail, restoreError: error?.message || String(error) }; }
    }
  }
  return { ok, detail };
}

module.exports = { runTrustedClickCheck, CLICK_TEST_URL, EXPECTED_RESULT };
