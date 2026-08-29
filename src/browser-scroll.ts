/**
 * Build the page-side expression used by every synthetic Bridge wheel path.
 * It follows the element beneath the viewport point up through its scrollable
 * ancestors, consumes only the delta each one can actually move, and forwards
 * the remainder to the document. overflow:hidden/clip elements are deliberately
 * excluded: a real wheel does not park on their programmatic residual range.
 */
export function browserScrollExpression(deltaX: number, deltaY: number, point?: { x?: number; y?: number }): string {
  const dx = Number.isFinite(Number(deltaX)) ? Number(deltaX) : 0;
  const dy = Number.isFinite(Number(deltaY)) ? Number(deltaY) : 0;
  const px = Number.isFinite(Number(point?.x)) ? Number(point?.x) : null;
  const py = Number.isFinite(Number(point?.y)) ? Number(point?.y) : null;
  return `(function(){
    var dx=${JSON.stringify(dx)},dy=${JSON.stringify(dy)};
    var cx=${px === null ? 'window.innerWidth/2' : JSON.stringify(px)};
    var cy=${py === null ? 'window.innerHeight/2' : JSON.stringify(py)};
    var root=document.scrollingElement||document.documentElement||document.body;
    var start=document.elementFromPoint?document.elementFromPoint(cx,cy):null;
    var chain=[],seen=[];
    function add(el,name){
      if(!el||seen.indexOf(el)>=0)return;
      seen.push(el);chain.push({el:el,name:name});
    }
    for(var node=start;node&&node.nodeType===1;node=node.parentElement){
      if(node===root||node===document.documentElement||node===document.body)continue;
      var style=getComputedStyle(node);
      var allowY=/^(auto|scroll|overlay)$/.test(style.overflowY||'');
      var allowX=/^(auto|scroll|overlay)$/.test(style.overflowX||'');
      if((allowY&&node.scrollHeight>node.clientHeight)||(allowX&&node.scrollWidth>node.clientWidth))add(node,'inner');
    }
    add(root,'window');
    var movedNames=[];
    var savedBehavior=[];
    for(var s=0;s<chain.length;s++){
      var scrollStyle=chain[s].el&&chain[s].el.style;
      if(!scrollStyle)continue;
      savedBehavior.push({style:scrollStyle,value:scrollStyle.scrollBehavior});
      scrollStyle.scrollBehavior='auto';
    }
    function consume(axis,amount){
      var remaining=amount;
      for(var i=0;i<chain.length&&remaining!==0;i++){
        var item=chain[i],el=item.el;
        var pos=axis==='y'?Number(el.scrollTop||0):Number(el.scrollLeft||0);
        var size=axis==='y'?Number(el.scrollHeight||0):Number(el.scrollWidth||0);
        var client=axis==='y'?Number(el.clientHeight||window.innerHeight||0):Number(el.clientWidth||window.innerWidth||0);
        var max=Math.max(0,size-client);
        var available=remaining>0?max-pos:pos;
        if(available<=0)continue;
        var requested=(remaining>0?1:-1)*Math.min(Math.abs(remaining),available);
        if(axis==='y')el.scrollTop=pos+requested;else el.scrollLeft=pos+requested;
        var after=axis==='y'?Number(el.scrollTop||0):Number(el.scrollLeft||0);
        var actual=after-pos;
        if(actual!==0&&movedNames.indexOf(item.name)<0)movedNames.push(item.name);
        remaining-=actual;
      }
      return remaining;
    }
    var rootBeforeX=Number((root&&root.scrollLeft)||0),rootBeforeY=Number((root&&root.scrollTop)||0);
    var remainingX=consume('x',dx),remainingY=consume('y',dy);
    var rootAfterX=Number((root&&root.scrollLeft)||0),rootAfterY=Number((root&&root.scrollTop)||0);
    for(var r=0;r<savedBehavior.length;r++)savedBehavior[r].style.scrollBehavior=savedBehavior[r].value;
    return JSON.stringify({
      target:chain.length?chain[0].name:'window',
      requested:{x:dx,y:dy},
      before:{x:rootBeforeX,y:rootBeforeY},
      after:{x:rootAfterX,y:rootAfterY},
      delta:{x:dx-remainingX,y:dy-remainingY},
      remaining:{x:remainingX,y:remainingY},
      chain:chain.map(function(item){return item.name;}),
      movedTargets:movedNames,
      canScroll:chain.length>0,
      moved:remainingX!==dx||remainingY!==dy
    });
  })()`;
}
