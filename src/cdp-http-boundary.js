'use strict';

// The CDP transport is for native local clients (including the wrapper), not
// for JavaScript in any browser page. UI lives at the wrapper's own origin.
function cdpHttpRefusal(headers, {port,host='127.0.0.1',method='GET',pathname='/'} = {}) {
  const supplied=headers.host;
  if(typeof supplied!=='string')return 'A valid Bridge host is required.';
  let address;
  try{address=new URL('http://'+supplied);}catch{return 'Invalid Bridge host.';}
  const hosts=new Set(['localhost','127.0.0.1','[::1]']);
  if(host && host!=='0.0.0.0' && host!=='::')hosts.add(host.includes(':')&&!host.startsWith('[')?'['+host+']':host.toLowerCase());
  if(address.username||address.password||address.pathname!=='/'||address.search||address.hash||!hosts.has(address.hostname)||Number(address.port||80)!==Number(port))return 'This request does not name the local Bridge service.';
  // A normal navigation may follow the legacy setup link to the canonical UI.
  if(method==='GET'&&pathname==='/welcome')return null;
  // Node's native fetch adds only sec-fetch-mode:cors. Browser fetches also
  // carry Origin or site/destination metadata; retain native fetch clients.
  if(headers.origin!==undefined||headers['sec-fetch-site']!==undefined||headers['sec-fetch-dest']!==undefined||(headers['sec-fetch-mode']!==undefined&&headers['sec-fetch-mode']!=='cors'))return 'Browser pages cannot call the internal Bridge transport. Use the local Bridge console or a native MCP client.';
  return null;
}
module.exports={cdpHttpRefusal};
