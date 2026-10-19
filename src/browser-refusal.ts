const CODES = new Set(['browser_tab_not_visible','page_loading','select_not_text_field','element_not_found',
  'element_not_actionable','focus_not_confirmed','typing_not_confirmed','click_not_confirmed',
  'target_closed','target_not_current','target_owned_by_user','target_mismatch','target_missing',
  'target_disabled','stale_observation','ambiguous_target','unsupported_control','invalid_ref','browser_dialog_pending','stale_dialog']);

/** Only expected safety/observation refusals cross the HTTP boundary as results. */
export function browserRefusal(error: any): any | null {
  const message = String(error?.error || error?.message || '');
  const code = error?.code || message.match(/^([a-z_]+):/)?.[1];
  if (!error?.actionFailure && !CODES.has(code)) return null;
  return {success:false,verified:false,code:code || 'element_not_actionable',error:message,
    inputMayHaveOccurred:error.inputMayHaveOccurred === true};
}

export function browserActionFailure(error: string, code: string, inputMayHaveOccurred = false): Error {
  return Object.assign(new Error(error), {actionFailure:true,code,inputMayHaveOccurred});
}
