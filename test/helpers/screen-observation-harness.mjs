import ts from 'typescript';
import vm from 'node:vm';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {createControlRuntime, validateTarget} from '../../src/control-runtime.js';
import {isPassiveGuiObservation} from '../../src/gui-observation.js';
import {SCREEN_READ_GUARD_PS, captureScreenObservation} from '../../src/windows-screen-observation.js';

// Exercise the real relay handler without booting a second tray, pointer
// overlay or account connection on the developer's desktop.
export function screenHarness(bindings = {}) {
  const source = ts.createSourceFile('server.ts', fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['handleGuiCommand','handleGuiCommandCore','takePassiveDesktopScreenshot','runScreenObservationPowerShellJson',
    'getDesktopMonitors','desktopCursorPosition','desktopPreamble','getImageDimensions','isComputerCommand','parseRelayStyleDesktopCommand','executeCommand'];
  const code = names.map(name => {
    const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (!node) throw new Error(`Missing server function: ${name}`);
    return node.getText(source);
  }).join('\n');
  const ctx = vm.createContext({console, process, Buffer, ...fs, join, validateTarget, isPassiveGuiObservation,
    SCREEN_READ_GUARD_PS, captureScreenObservation, controlRuntime:createControlRuntime(), desktopFocus:null,
    COMPANION_SCREENSHOT_MAX_BASE64_CHARS:900000, CONTROL_BROWSER_ACTIONS:new Set(['click','navigate']),
    guiTimestamps:[], getControlLimits:()=>({nativeTimeoutMs:10000}), hasBridgePermission:()=>true,
    permissionDenied:permission=>({success:false,error:`${permission} disabled`}), checkRateLimit:()=>null,
    ...bindings});
  vm.runInContext(ts.transpileModule(code, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, ctx);
  // The production HTTP entry calls Core after its policy gate. Keep this
  // adapter minimal so the test also exercises the outer lease classification.
  ctx.executeCommandCore = async cmd => {
    if (ctx.enforceCommandPolicy?.(cmd)) return ctx.enforceCommandPolicy(cmd);
    const parsed = ctx.parseRelayStyleDesktopCommand(cmd);
    if (parsed?.base === 'desktop:gui') return ctx.handleGuiCommand(parsed.action || 'screenshot', parsed.params);
    throw new Error(`Unexpected command: ${cmd.type}`);
  };
  return ctx;
}
