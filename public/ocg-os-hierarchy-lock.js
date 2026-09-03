(()=>{
 const replace=()=>{
  document.querySelectorAll('.narrative-badge').forEach(el=>{if(/PIPER\s+HEAD\s+AGENT\s+BRIEF/i.test(el.textContent||''))el.textContent='✦ PIPER SELLER PIPELINE BRIEF';});
 };
 const start=()=>{replace();const view=document.getElementById('view');if(view)new MutationObserver(replace).observe(view,{childList:true,subtree:true,characterData:true});};
 document.readyState==='loading'?document.addEventListener('DOMContentLoaded',start,{once:true}):start();
})();
