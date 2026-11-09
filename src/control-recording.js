'use strict';
const {validatePlan}=require('./control-runtime.js');
const {getControlLimits}=require('./control-limits.js');

// Older v2 recordings emitted null for clicks without an outcome assertion.
// Normalize only that legacy representation; malformed conditions still fail.
function validateRecordedSteps(submitted,target,limits=getControlLimits()) {
  if(!Array.isArray(submitted))throw new Error('Invalid recording steps.');
  const steps=submitted.map(step=>{
    const copy={...step};
    if(copy.action==='click'&&copy.expect===null)delete copy.expect;
    return copy;
  });
  return validatePlan({target,steps},{...limits,planSteps:limits.recordingSteps}).steps;
}
module.exports={validateRecordedSteps};
