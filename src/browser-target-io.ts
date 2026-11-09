export interface PageSession {
  targetId: string;
  send(method: string, params?: any, timeoutMs?: number): Promise<any>;
  close(): void;
}

/** Navigate and read back the same CDP target, including redirects. */
export async function navigatePageSession(session: PageSession, requestedUrl: string, timeoutMs = 10000) {
  await session.send('Page.enable');
  const navigation = await session.send('Page.navigate', { url: requestedUrl });
  if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
  if (navigation.isDownload) {
    const tree = await session.send('Page.getFrameTree');
    return { success: true, targetId: session.targetId, requestedUrl, url: tree.frameTree?.frame?.url || '', loaded: false, isDownload: true };
  }
  const deadline = Date.now() + timeoutMs;
  let observed: any;
  do {
    try {
      const tree = await session.send('Page.getFrameTree', {}, 1500);
      const frame = tree.frameTree?.frame;
      // A previous document's readyState must not certify the new page.
      if (!navigation.loaderId || frame?.loaderId === navigation.loaderId) {
        const read = await session.send('Runtime.evaluate', {
          expression: '({url:location.href,title:document.title,readyState:document.readyState})', returnByValue: true,
        }, 1500);
        observed = read.result?.value;
        if (observed?.url && ['interactive','complete'].includes(observed.readyState)) {
          return { success: true, targetId: session.targetId, requestedUrl, ...observed, loaded: true, verified: true };
        }
      }
    } catch (error: any) {
      if (!/context|navigat|timeout/i.test(error.message)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  const tree = await session.send('Page.getFrameTree');
  return { success: false, targetId: session.targetId, requestedUrl, url: tree.frameTree?.frame?.url || '',
    loaded: false, verified: false, code: 'page_loading', error: 'Navigation started; the page has not finished loading. Observe this target before continuing.' };
}
