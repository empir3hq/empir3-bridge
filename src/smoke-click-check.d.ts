export interface TrustedClickAdapter {
  currentTargetId: () => Promise<string>;
  createTab: (url: string) => Promise<string>;
  click: (x: number, y: number) => Promise<void>;
  evaluate: (expression: string) => Promise<any>;
  closeTab: (targetId: string) => Promise<void>;
  activate: (targetId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export function runTrustedClickCheck(adapter: TrustedClickAdapter): Promise<{ ok: boolean; detail: any }>;
export const CLICK_TEST_URL: string;
export const EXPECTED_RESULT: string;
