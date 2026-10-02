const map=L.map('map',{zoomControl:false}).setView([48.0,10.0],7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap'}).addTo(map);
L.control.zoom({position:'bottomright'}).addTo(map);
const statusEl=document.querySelector('#status'),sheet=document.querySelector('#sheet'),notice=document.querySelector('#notice');
let markerByHex=new Map(),center=[48,10],locationMarker=null,accuracyCircle=null,loading=false,lastLoad=0,lastGood=[],lastSuccess=0,failCount=0,selectedHex=null,selectedAircraft=null,selectedMissingSince=0,trailLayer=null,trailByHex=new Map(),routeLayer=null;
let activeController=null,requestSeq=0,latestAppliedSeq=0,mapInteraction=false,mapReloadTimer=null,activeAbortReason='';
let searching=false,searchController=null,searchRun=0;
const enrichCache=new Map(),enrichPending=new Map(),routeCache=new Map(),routePending=new Map();
const REFRESH_MS=15000, MOVE_MS=14000, REQUEST_TIMEOUT_MS=4000, RETRY_DELAY_MS=1500;
let netDiag={attempt:0,lastMs:null,lastResult:'',lastAt:0};
let pendingLoad=false,pendingLoadForce=false,retryTimer=null,retryUsed=false;
const DIAG_KEY='flight-tracker-diag-v41';let diagLog=[];try{diagLog=JSON.parse(localStorage.getItem(DIAG_KEY)||'[]')}catch(_){diagLog=[]}let lastDiagSuccessAt=0;
function saveDiag(){try{localStorage.setItem(DIAG_KEY,JSON.stringify(diagLog.slice(-30)))}catch(_){}}
function addDiag(x){diagLog.push(x);if(diagLog.length>60)diagLog=diagLog.slice(-60);saveDiag();renderDiag()}
function diagEvent(result,detail=''){addDiag({at:Date.now(),ok:true,event:true,result,detail,totalMs:null,upstreamMs:null,gapMs:null,count:null})}
function abortActive(reason){if(!activeController)return;activeAbortReason=reason||'unbekannt';diagEvent('ABORT ausgelöst',activeAbortReason);activeController.abort()}
function fmtDiagMs(v){return v==null?'—':v<1000?Math.round(v)+' ms':(v/1000).toFixed(1).replace('.',',')+' s'}

function buildDiagText(){
  const req=diagLog.filter(x=>!x.event),ok=req.filter(x=>x.ok).length,bad=req.length-ok;
  const avg=req.filter(x=>x.ok&&x.totalMs!=null);const avgMs=avg.length?Math.round(avg.reduce((a,x)=>a+x.totalMs,0)/avg.length):null;
  const lines=[
    'Flight Tracker v4.3 - Live-Diagnose',
    `Export: ${new Date().toLocaleString('de-DE')}`,
    `Soll-Intervall: ${(REFRESH_MS/1000).toFixed(0)} s`,
    `Erfolg/Fehler: ${ok}/${bad}`,
    `Durchschnittliche Antwortzeit: ${fmtDiagMs(avgMs)}`,
    '',
    'Zeit | Ergebnis | Detail | Gesamt | Upstream | Abstand | Flugzeuge'
  ];
  for(const x of diagLog){
    lines.push([
      new Date(x.at).toLocaleTimeString('de-DE',{hour12:false}),
      x.result||'',
      (x.detail||'').replace(/\s+/g,' ').trim(),
      x.event?'—':fmtDiagMs(x.totalMs),
      x.event?'—':fmtDiagMs(x.upstreamMs),
      x.event?'—':(x.gapMs==null?'—':fmtDiagMs(x.gapMs)),
      x.event?'—':(x.count??'—')
    ].join(' | '));
  }
  return lines.join('\n');
}
async function copyDiagLog(){
  const btn=document.querySelector('#diagCopy');
  const text=buildDiagText();
  try{
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text)}else{
      const ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
      if(!document.execCommand('copy'))throw new Error('copy failed');ta.remove();
    }
    if(btn){const old=btn.textContent;btn.textContent='✓ Log kopiert';setTimeout(()=>btn.textContent=old,1800)}
  }catch(e){
    if(btn){const old=btn.textContent;btn.textContent='Kopieren fehlgeschlagen';setTimeout(()=>btn.textContent=old,2200)}
  }
}
function renderDiag(){const sum=document.querySelector('#diagSummary'),rows=document.querySelector('#diagRows');if(!sum||!rows)return;const req=diagLog.filter(x=>!x.event),last=req[req.length-1],ok=req.filter(x=>x.ok).length,bad=req.length-ok;const avg=req.filter(x=>x.ok&&x.totalMs!=null);const avgMs=avg.length?Math.round(avg.reduce((a,x)=>a+x.totalMs,0)/avg.length):null;sum.innerHTML=`<div class="diagCard"><small>Soll-Intervall</small><strong>${(REFRESH_MS/1000).toFixed(0)} s</strong></div><div class="diagCard"><small>Letzter Abruf</small><strong>${last?fmtDiagMs(last.totalMs):'—'}</strong></div><div class="diagCard"><small>Ø Antwortzeit</small><strong>${fmtDiagMs(avgMs)}</strong></div><div class="diagCard"><small>Erfolg / Fehler</small><strong>${ok} / ${bad}</strong></div>`;rows.innerHTML=diagLog.slice().reverse().map(x=>`<tr><td>${new Date(x.at).toLocaleTimeString('de-DE')}</td><td class="${x.event?'diagEvent':(x.ok?'diagOk':'diagBad')}">${x.result}${x.detail?`<small class="diagDetail">${x.detail}</small>`:''}</td><td>${x.event?'—':fmtDiagMs(x.totalMs)}</td><td>${x.event?'—':fmtDiagMs(x.upstreamMs)}</td><td>${x.event?'—':(x.gapMs==null?'—':fmtDiagMs(x.gapMs))}</td><td>${x.event?'—':(x.count??'—')}</td></tr>`).join('')}

let connectionReady=false,startRetryTimer=null,startRetryStep=0;
let nextRefreshAt=0;const countdownEl=document.querySelector('#countdown'),refreshRing=document.querySelector('#refreshRing');
function setConnectingUi(){countdownEl.textContent='↻';refreshRing.style.setProperty('--p','0deg');refreshRing.classList.add('loading')}
function armNormalRefresh(){connectionReady=true;startRetryStep=0;if(startRetryTimer){clearTimeout(startRetryTimer);startRetryTimer=null}refreshRing.classList.remove('loading')}
function scheduleStartupRetry(){if(connectionReady||searching)return;const delays=[1000,2000,3000];const delay=delays[Math.min(startRetryStep,delays.length-1)];startRetryStep++;if(startRetryTimer)clearTimeout(startRetryTimer);setConnectingUi();startRetryTimer=setTimeout(()=>{startRetryTimer=null;if(!connectionReady&&!searching)load(true,'Start-Retry')},delay)}
const kmh=v=>v==null?'—':Math.round(v*3.6)+' km/h';
const celsius=v=>v==null?'':Math.round(v)+' °C';
const windText=(dir,spd)=>dir==null||spd==null?'':`${Math.round(spd*1.852)} km/h aus ${compassWord(dir)}`;
function compassWord(d){if(d==null)return'';return ['Norden','Nordosten','Osten','Südosten','Süden','Südwesten','Westen','Nordwesten'][Math.round(d/45)%8]}
const machText=v=>v==null?'':`Mach ${Number(v).toFixed(2).replace('.',',')}`;
const metres=v=>v==null?'—':Math.round(v).toLocaleString('de-DE')+' m';
function compass(d){if(d==null)return'—';return ['N','NO','O','SO','S','SW','W','NW'][Math.round(d/45)%8]+' · '+Math.round(d)+'°'}
function ageText(){if(!lastSuccess)return'';const s=Math.max(0,Math.round((Date.now()-lastSuccess)/1000));return s<5?'gerade aktualisiert':`vor ${s} Sek. aktualisiert`}
function visibleAircraftCount(){const b=map.getBounds();let n=0;for(const a of lastGood)if(a.lat!=null&&a.lon!=null&&b.contains([a.lat,a.lon]))n++;return n}
function updateStatus(){if(lastGood.length){const n=visibleAircraftCount();statusEl.textContent=`${n} Flugzeuge im Kartenausschnitt · ${ageText()}`;}}
const airlines={RYR:'Ryanair',DLH:'Lufthansa',AIC:'Air India',LOT:'LOT Polish Airlines',EWG:'Eurowings',EZY:'easyJet',SWR:'SWISS',AUA:'Austrian Airlines',BAW:'British Airways',KLM:'KLM',AFR:'Air France',THY:'Turkish Airlines',UAE:'Emirates',QTR:'Qatar Airways',SAS:'SAS',IBE:'Iberia',VLG:'Vueling',WZZ:'Wizz Air',CFG:'Condor',TUI:'TUI fly',BEL:'Brussels Airlines'};
function airlineName(a){const f=(a.flight||'').trim().toUpperCase(),m=f.match(/^([A-Z]{3})/);return m&&airlines[m[1]]?airlines[m[1]]:''}
function airportLabel(x){if(!x)return'';return x.iata_code||x.icao_code||x.municipality||x.name||''}
function flightKind(a,e={}){
  const ac=e.aircraft||{},r=e.flightroute||{};
  const flight=(a.flight||r.callsign_icao||r.callsign_iata||'').trim().toUpperCase();
  const prefix=(flight.match(/^([A-Z]{3})/)||[])[1]||'';
  const airline=(r.airline?.name||airlineName(a)||'').toUpperCase();
  const owner=(ac.registered_owner||'').toUpperCase();
  const text=[airline,owner,(a.description||'').toUpperCase()].join(' ');
  const cargoPrefixes=new Set(['FDX','UPS','CLX','BOX','GTI','ABW','NCA','CKS','PAC','BCS','SRR','TAY','AHK','MNB']);
  const passengerPrefixes=new Set(['RYR','DLH','AIC','LOT','EWG','EZY','SWR','AUA','BAW','KLM','AFR','THY','UAE','QTR','SAS','IBE','VLG','WZZ','CFG','TUI','BEL']);
  const businessPrefixes=new Set(['NJE','VJT','EJM','LXJ']);
  if(cargoPrefixes.has(prefix)||/FEDEX|UPS AIR|CARGOLUX|AIRBRIDGECARGO|NIPPON CARGO|POLAR AIR CARGO|SILK WAY|DHL/.test(text))return['📦','Frachtflug','cargo'];
  if(/DRF|LUFTRETTUNG|AIR RESCUE|RETTUNG|MEDEVAC/.test(text))return['🚁','Rettungsflug','rescue'];
  if(/POLIZEI|POLICE|BUNDESPOLIZEI/.test(text))return['🚓','Polizei / Behörde','authority'];
  if(/MILITARY|AIR FORCE|LUFTWAFFE|ARMY|NAVY/.test(text))return['✈️','Militär','military'];
  if(businessPrefixes.has(prefix)||/NETJETS|VISTAJET|EXECUTIVE JET|PRIVATE JET/.test(text))return['🛩️','Geschäftsflug','business'];
  if(passengerPrefixes.has(prefix)&&r.origin&&r.destination)return['👥','Passagierflug','passenger'];
  return null;
}
function enrichKey(a){return (a.hex||a.registration||'')+'|'+(a.flight||'')}
async function enrichAircraft(a){
  const key=enrichKey(a); if(!key.replace('|',''))return null;
  if(enrichCache.has(key))return enrichCache.get(key);
  if(enrichPending.has(key))return enrichPending.get(key);
  const task=(async()=>{try{
    const id=encodeURIComponent((a.hex||a.registration||'').trim()); if(!id)return null;
    const cs=(a.flight||'').trim(); const url=`https://api.adsbdb.com/v0/aircraft/${id}${cs?'?callsign='+encodeURIComponent(cs):''}`;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
    try{const r=await fetch(url,{signal:controller.signal}); if(!r.ok)return null; const d=await r.json(); const x=d?.response||null; enrichCache.set(key,x);return x}finally{clearTimeout(timer)}
  }catch(e){console.warn('ADSBDB',e);return null}finally{enrichPending.delete(key)}})();
  enrichPending.set(key,task); return task;
}
async function lookupVerifiedRoute(a){
  const callsign=(a.flight||'').trim().toUpperCase();
  if(!callsign||a.lat==null||a.lon==null)return null;
  const key=`${callsign}|${a.lat.toFixed(1)}|${a.lon.toFixed(1)}`;
  if(routeCache.has(key))return routeCache.get(key);
  if(routePending.has(key))return routePending.get(key);
  const task=(async()=>{try{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
    try{
      const u=new URL('https://gregorflighttracker.val.run/');u.searchParams.set('route',callsign);u.searchParams.set('lat',a.lat);u.searchParams.set('lon',a.lon);
      const r=await fetch(u,{cache:'no-store',signal:controller.signal});
      if(!r.ok)return null; const d=await r.json(); const x=d?.route||(Array.isArray(d)?d[0]:(Array.isArray(d?.routes)?d.routes[0]:null));
      const airports=x?._airports||[]; const valid=!!(x&&x.plausible===true&&airports.length>=2);
      const route=valid?{origin:airports[0],destination:airports[airports.length-1],codes:x._airport_codes_iata||x.airport_codes||''}:null;
      routeCache.set(key,route);return route;
    }finally{clearTimeout(timer)}
  }catch(e){console.warn('Route lookup',e);return null}finally{routePending.delete(key)}})();
  routePending.set(key,task);return task;
}
function drawRoute(a){if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}const r=a.verifiedRoute;if(!r?.destination||a.lat==null||a.lon==null)return;const d=r.destination;routeLayer=L.polyline([[a.lat,a.lon],[d.lat,d.lon]],{color:'#1677ff',weight:3,dashArray:'8 8',opacity:.8}).addTo(map)}
function fillDetails(a){
  const e=a.enrichment||{},ac=e.aircraft||{},r=e.flightroute||{};
  const alt=metres(a.alt),speed=kmh(a.speed),heading=compass(a.track);
  const flight=(r.callsign_iata||r.callsign_icao||a.flight||a.registration||'Unbekanntes Fluggerät').trim();
  const airline=r.airline?.name||airlineName(a)||ac.registered_owner||'';
  const type=[ac.manufacturer,ac.type].filter(Boolean).join(' ')||a.aircraftType||'';
  const reg=ac.registration||a.registration||'';
  document.querySelector('#flight').textContent=flight; document.querySelector('#detailFlight').textContent=flight;
  document.querySelector('#airline').textContent=airline; document.querySelector('#detailAirline').textContent=airline;
  const kind=flightKind(a,e); const kindText=kind?`${kind[0]} ${kind[1]}`:''; document.querySelector('#flightKind').textContent=kindText; document.querySelector('#flightKind').classList.toggle('hiddenKind',!kind); document.querySelector('#detailFlightKind').textContent=kindText; document.querySelector('#detailFlightKind').classList.toggle('hiddenKind',!kind);
  document.querySelector('#reg').textContent=[type,reg&&('· '+reg)].filter(Boolean).join(' ')||'Keine weiteren Angaben';
  document.querySelector('#detailType').textContent=[type,reg&&('· '+reg)].filter(Boolean).join(' ')||'Keine weiteren Angaben';
  const vr=a.verifiedRoute||null,o=vr?.origin||null,d=vr?.destination||null;const routeText=o&&d?`${airportLabel(o)} → ${airportLabel(d)}`:'Route nicht sicher bestimmt';
  const routeNames=o&&d?[o.name||o.location,d.name||d.location].filter(Boolean).join(' → '):'Start/Ziel werden nur angezeigt, wenn die positionsbezogene Routenzuordnung plausibel ist.';
  const routeBox=document.querySelector('.routeBox');document.querySelector('#route').textContent=routeText;routeBox.classList.toggle('noRoute',!o&&!d);document.querySelector('#routeNames').textContent=routeNames;
  document.querySelector('#detailRoute').textContent=routeText;document.querySelector('#detailRouteNames').textContent=routeNames;
  const photo=ac.url_photo||ac.url_photo_thumbnail||'';const img=document.querySelector('#detailPhoto');if(photo){img.src=photo;img.classList.remove('hiddenPhoto')}else{img.removeAttribute('src');img.classList.add('hiddenPhoto')}
  document.querySelector('#alt').textContent=alt;document.querySelector('#speed').textContent=speed;document.querySelector('#heading').textContent=heading;document.querySelector('#altDetail').textContent=alt;document.querySelector('#speedDetail').textContent=speed;document.querySelector('#headingDetail').textContent=heading;document.querySelector('#rate').textContent=a.rate==null?'—':Math.abs(Math.round(a.rate*60))+' m/min '+(a.rate>.5?'↑':a.rate<-.5?'↓':'→');
  const facts=[]; if(a.oat!=null)facts.push(['Außentemperatur',celsius(a.oat),'🌡️']); if(a.windDir!=null&&a.windSpeed!=null)facts.push(['Wind',windText(a.windDir,a.windSpeed),'💨']); if(a.mach!=null)facts.push(['Reisegeschwindigkeit',machText(a.mach),'🚀']); if(a.altGeom!=null)facts.push(['Geometrische Höhe',metres(a.altGeom),'📏']);
  const factsEl=document.querySelector('#interestingFacts'); factsEl.innerHTML=facts.map(([k,v,i])=>`<div class="fact"><span>${i}</span><small>${k}</small><strong>${v}</strong></div>`).join(''); factsEl.classList.toggle('hiddenFacts',!facts.length);
  document.querySelector('#tech').textContent=[a.hex&&('ICAO '+a.hex.toUpperCase()),a.squawk&&('Squawk '+a.squawk),a.source&&('Positionsquelle '+a.source.toUpperCase()),a.tas!=null&&('TAS '+Math.round(a.tas*1.852)+' km/h'),a.ias!=null&&('IAS '+Math.round(a.ias*1.852)+' km/h'),ac.registered_owner&&('Halter '+ac.registered_owner)].filter(Boolean).join(' · ')||'Live-Positionsdaten';drawRoute(a)
}
function addTrailPoint(a){if(!a.hex||a.lat==null||a.lon==null)return;let pts=trailByHex.get(a.hex)||[];const last=pts[pts.length-1];if(!last||Math.abs(last[0]-a.lat)>0.00005||Math.abs(last[1]-a.lon)>0.00005){pts.push([a.lat,a.lon]);if(pts.length>240)pts=pts.slice(-240);trailByHex.set(a.hex,pts)}if(normHex(a.hex)===normHex(selectedHex))drawTrail(a.hex)}
function drawTrail(hex){if(trailLayer){map.removeLayer(trailLayer);trailLayer=null}const pts=trailByHex.get(hex)||[];if(pts.length>1)trailLayer=L.polyline(pts,{color:'#ff9f0a',weight:3,opacity:.8}).addTo(map);if(selectedAircraft)drawRoute(selectedAircraft)}
function normHex(v){return String(v||'').trim().toLowerCase()}
function selectAircraft(a){selectedHex=normHex(a.hex)||null;selectedAircraft=a;selectedMissingSince=0;fillDetails(a);sheet.classList.remove('detail');sheet.classList.add('compact');sheet.classList.remove('hidden');drawTrail(selectedHex);refreshMarkerStyles();requestAnimationFrame(()=>keepSelectedVisible(a,true));enrichAircraft(a).then(e=>{if(e&&normHex(selectedHex)===normHex(a.hex)){a.enrichment=e;selectedAircraft=a;fillDetails(a)}});lookupVerifiedRoute(a).then(r=>{if(normHex(selectedHex)===normHex(a.hex)){a.verifiedRoute=r;selectedAircraft=a;fillDetails(a);drawRoute(a);requestAnimationFrame(()=>keepSelectedVisible(a,true))}})}
const svgPlane=`<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M29 3h6l3 23 19 10v6l-19-4-2 15 8 5v4l-12-2-12 2v-4l8-5-2-15-19 4v-6l19-10z"/></svg>`;
const svgHeli=`<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 13h48v4H35v8c8 1 14 7 15 15h7v5h-8c-2 7-8 11-16 11H20c-7 0-12-5-12-12 0-8 6-14 14-14h7V17H8zm14 23c-5 0-8 3-8 8 0 4 3 6 7 6h11V36zm16 0v14c4-1 7-4 7-8s-3-6-7-6z"/><path d="M46 24h4v9h-4zM50 27h10v4H50z"/></svg>`;
const svgLight=`<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M29 6h6l2 22 20 7v6l-20-2-2 13 8 4v4l-11-2-11 2v-4l8-4-2-13-20 2v-6l20-7z"/></svg>`;
function craftKind(a){const d=(a.description||'').toUpperCase(),t=(a.aircraftType||'').toUpperCase();if(d.includes('ROTOR')||d.includes('HELICOPTER')||/^(R22|R44|R66|EC|H1[2345]|AS3|B06|B4|S76|A109|A139|A169|A189)/.test(t))return'heli';if(d.includes('LIGHT')||d.includes('ULTRALIGHT')||/^(C1|C2|C3|C4|PA|SR2|DA|P28|BE|M20)/.test(t))return'light';return'plane'}
function iconPx(){const z=map.getZoom();return z<=8?20:z<=10?23:z<=12?26:29}
function craftIcon(a,selected=false){const kind=craftKind(a),svg=kind==='heli'?svgHeli:kind==='light'?svgLight:svgPlane,px=iconPx();return L.divIcon({className:'craft-marker',html:`<div class="craft ${kind}${selected?' selected':''}" style="--craft-size:${px}px;transform:rotate(${a.track||0}deg)">${svg}</div>`,iconSize:[px,px],iconAnchor:[px/2,px/2]})}
function refreshMarkerStyles(){for(const [hex,obj] of markerByHex){const isSelected=normHex(hex)===normHex(selectedHex);obj.marker.setIcon(craftIcon(obj.aircraft,isSelected));obj.marker.setZIndexOffset(isSelected?2000:0);if(isSelected&&obj.marker.bringToFront)obj.marker.bringToFront()}}
function keepSelectedVisible(a,animate=false){
  if(!a||a.lat==null||a.lon==null)return;
  const mapRect=document.querySelector('#map').getBoundingClientRect();
  const searchRect=document.querySelector('#searchBar').getBoundingClientRect();
  const sheetVisible=!sheet.classList.contains('hidden');
  const sheetRect=sheetVisible?sheet.getBoundingClientRect():null;
  const top=Math.max(searchRect.bottom+12,mapRect.top+90);
  const bottom=sheetVisible?Math.max(top+80,sheetRect.top-14):mapRect.bottom-50;
  const targetY=top+(bottom-top)*0.48;
  const p=map.latLngToContainerPoint([a.lat,a.lon]);
  const deltaY=p.y-targetY;
  if(Math.abs(deltaY)>4||animate){map.panBy([0,deltaY],{animate,duration:animate?.28:0});}
}
function animateMarker(obj,a){
  if(obj.animFrame)cancelAnimationFrame(obj.animFrame);
  const from=obj.marker.getLatLng(),to=L.latLng(a.lat,a.lon);
  if(!from||!Number.isFinite(from.lat)||Math.abs(from.lat-to.lat)+Math.abs(from.lng-to.lng)>8){obj.marker.setLatLng(to);return}
  const started=performance.now();
  const step=now=>{const t=Math.min(1,(now-started)/MOVE_MS),ease=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;obj.marker.setLatLng([from.lat+(to.lat-from.lat)*ease,from.lng+(to.lng-from.lng)*ease]);if(t<1)obj.animFrame=requestAnimationFrame(step);else obj.animFrame=null};
  obj.animFrame=requestAnimationFrame(step)
}
function draw(list){lastGood=list;const next=new Map();for(const a of list){if(a.lat==null||a.lon==null)continue;addTrailPoint(a);const key=normHex(a.hex)||`${a.lat}:${a.lon}:${a.flight}`;let obj=markerByHex.get(key);if(obj){obj.aircraft=a;animateMarker(obj,a);obj.marker.setIcon(craftIcon(a,normHex(key)===normHex(selectedHex)))}else{const m=L.marker([a.lat,a.lon],{icon:craftIcon(a,normHex(key)===normHex(selectedHex)),keyboard:false,riseOnHover:true}).addTo(map);obj={marker:m,aircraft:a};m.on('click',()=>selectAircraft(obj.aircraft))}next.set(key,obj)}if(selectedHex&&!next.has(selectedHex)&&markerByHex.has(selectedHex)){if(!selectedMissingSince)selectedMissingSince=Date.now();if(Date.now()-selectedMissingSince<20000){const held=markerByHex.get(selectedHex);held.marker.setIcon(craftIcon(held.aircraft,true));held.marker.setZIndexOffset(2000);next.set(selectedHex,held)}}for(const [key,obj] of markerByHex)if(!next.has(key)){if(obj.animFrame)cancelAnimationFrame(obj.animFrame);map.removeLayer(obj.marker);}markerByHex=next;if(selectedHex&&markerByHex.has(selectedHex)){const fresh=markerByHex.get(selectedHex).aircraft;if(list.some(a=>normHex(a.hex)===normHex(selectedHex))){selectedMissingSince=0;fresh.enrichment=selectedAircraft?.enrichment;fresh.verifiedRoute=selectedAircraft?.verifiedRoute;selectedAircraft=fresh;fillDetails(selectedAircraft);drawRoute(selectedAircraft)}markerByHex.get(selectedHex).marker.setZIndexOffset(2000)}else if(selectedHex&&selectedMissingSince&&Date.now()-selectedMissingSince>=20000){selectedHex=null;selectedAircraft=null;selectedMissingSince=0;sheet.classList.add('hidden');if(trailLayer){map.removeLayer(trailLayer);trailLayer=null}if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}}refreshMarkerStyles();requestAnimationFrame(refreshMarkerStyles);lastSuccess=Date.now();failCount=0;notice.classList.add('hiddenNotice');updateStatus()}
function queryForCurrentMap(){
  const b=map.getBounds(),c=b.getCenter();
  const corners=[b.getNorthWest(),b.getNorthEast(),b.getSouthWest(),b.getSouthEast()];
  let maxM=0; for(const x of corners)maxM=Math.max(maxM,map.distance(c,x));
  // adsb.lol point endpoint accepts nautical miles. Add a small margin, capped at 250 NM.
  const radius=Math.min(250,Math.max(10,Math.ceil((maxM/1852)*1.12)));
  return {lat:c.lat,lon:c.lng,radius};
}
async function fetchProxy(signal,query){const u=new URL('https://gregorflighttracker.val.run/');u.searchParams.set('lat',query.lat.toFixed(4));u.searchParams.set('lon',query.lon.toFixed(4));u.searchParams.set('radius',String(query.radius));const started=performance.now();const wallStarted=Date.now();netDiag.attempt++;try{const r=await fetch(u,{cache:'no-store',signal});const ms=Math.round(performance.now()-started);netDiag.lastMs=ms;netDiag.lastAt=Date.now();let d=null;try{d=await r.json()}catch(_){d={}}if(!r.ok){netDiag.lastResult='HTTP '+r.status;addDiag({at:wallStarted,ok:false,result:'HTTP '+r.status,totalMs:ms,upstreamMs:d?.ft_upstream_ms??null,gapMs:null,count:null});throw Error('Flight Tracker API '+r.status)}netDiag.lastResult='OK';const gap=lastDiagSuccessAt?wallStarted-lastDiagSuccessAt:null;lastDiagSuccessAt=wallStarted;const arr=(d.ac||[]);addDiag({at:wallStarted,ok:true,result:'HTTP '+r.status,totalMs:ms,upstreamMs:d?.ft_upstream_ms??null,gapMs:gap,count:arr.length});return arr.map(a=>({hex:a.hex,flight:(a.flight||a.callsign||'').trim(),registration:a.r||'',aircraftType:a.t||'',description:a.desc||'',category:a.category||'',lon:a.lon,lat:a.lat,alt:a.alt_baro==='ground'?0:(a.alt_baro==null?null:a.alt_baro*.3048),altGeom:a.alt_geom==null?null:a.alt_geom*.3048,speed:a.gs==null?null:a.gs*.514444,track:a.track,rate:a.baro_rate==null?null:a.baro_rate*.00508,squawk:a.squawk,source:a.type||'',oat:a.oat??null,tat:a.tat??null,mach:a.mach??null,windDir:a.wd??null,windSpeed:a.ws??null,ias:a.ias??null,tas:a.tas??null}))}catch(e){const ms=Math.round(performance.now()-started);if(e?.name==='AbortError'){addDiag({at:wallStarted,ok:false,result:'ABBRUCH',detail:activeAbortReason||'AbortController',totalMs:ms,upstreamMs:null,gapMs:null,count:null})}else{addDiag({at:wallStarted,ok:false,result:'NETZWERKFEHLER',detail:e?.message||String(e),totalMs:ms,upstreamMs:null,gapMs:null,count:null})}throw e}}
async function load(force=false,reason='scheduler'){
  if(searching)return;
  if(mapInteraction&&!force)return;
  if(loading){pendingLoad=true;pendingLoadForce=pendingLoadForce||force;diagEvent('REQUEST vorgemerkt',reason);return;}
  if(!force&&Date.now()-lastLoad<4000)return;
  const seq=++requestSeq,query=queryForCurrentMap();
  const controller=new AbortController();activeController=controller;activeAbortReason='';
  diagEvent('REQUEST gestartet',`seq ${seq} · ${reason} · ${query.lat.toFixed(3)}, ${query.lon.toFixed(3)} · ${query.radius} NM`);
  let timedOut=false,completed=false;
  const timer=setTimeout(()=>{if(completed)return;timedOut=true;activeAbortReason='echter 4-s-Timeout';diagEvent('TIMEOUT ausgelöst',`seq ${seq} · 4 s ohne Antwort`);controller.abort()},REQUEST_TIMEOUT_MS);
  loading=true;lastLoad=Date.now();nextRefreshAt=lastLoad+REFRESH_MS;refreshRing.classList.add('loading');
  if(!lastGood.length)statusEl.textContent='Live-Flugzeuge werden geladen…';
  try{
    const list=await fetchProxy(controller.signal,query);completed=true;
    if(seq!==requestSeq){diagEvent('REQUEST veraltet',`seq ${seq}`);return;}
    latestAppliedSeq=seq;draw(list);armNormalRefresh();retryUsed=false;
  }catch(e){
    completed=true;
    if(seq!==requestSeq){diagEvent('REQUEST Ende veraltet',`seq ${seq} · ${e?.name||'Fehler'}`);return;}
    if(timedOut){netDiag.lastMs=REQUEST_TIMEOUT_MS;netDiag.lastResult='TIMEOUT';netDiag.lastAt=Date.now();}
    const intentionalAbort=e?.name==='AbortError'&&!timedOut;
    if(intentionalAbort){diagEvent('REQUEST beendet',`seq ${seq} · absichtlich abgebrochen`);return;}
    console.warn(e);failCount++;
    if(connectionReady||lastGood.length){updateStatus();if(failCount>=3){notice.textContent='Live-Aktualisierung momentan unterbrochen. Die zuletzt geladenen Flugzeuge bleiben sichtbar.';notice.classList.remove('hiddenNotice')}}
    else{statusEl.textContent='Live-Verbindung wird aufgebaut…';notice.textContent=timedOut?'Keine Antwort nach 4 Sek. · neuer Versuch folgt automatisch…':'Live-Verbindung wird aufgebaut – automatischer neuer Versuch…';notice.classList.remove('hiddenNotice')}
    if(!retryUsed&&document.visibilityState==='visible'&&!searching){retryUsed=true;clearTimeout(retryTimer);diagEvent('RETRY geplant',`seq ${seq} · in ${RETRY_DELAY_MS/1000} s`);retryTimer=setTimeout(()=>{retryTimer=null;load(true,'einmaliger Retry')},RETRY_DELAY_MS)}
    else if(!connectionReady)scheduleStartupRetry();
  }finally{
    clearTimeout(timer);
    if(seq===requestSeq){loading=false;activeController=null;if(connectionReady)refreshRing.classList.remove('loading');else setConnectingUi()}
    if(pendingLoad&&!loading){const f=pendingLoadForce;pendingLoad=false;pendingLoadForce=false;setTimeout(()=>load(f,'vorgemerkter Abruf'),0)}
  }
}
function scheduleMapReload(){
  clearTimeout(mapReloadTimer);
  mapReloadTimer=setTimeout(()=>{mapInteraction=false;const c=map.getCenter();center=[c.lat,c.lng];diagEvent('KARTE stabil','1,0 s ohne Bewegung');statusEl.textContent='Lade Flugzeuge für diesen Kartenausschnitt…';nextRefreshAt=Date.now()+REFRESH_MS;load(true,'Kartenbereich geändert')},1000);
}
const searchInput=document.querySelector('#flightSearch'),searchMsg=document.querySelector('#searchMsg');
function showSearchMsg(t){searchMsg.textContent=t;searchMsg.classList.remove('hiddenSearch');clearTimeout(showSearchMsg.t);showSearchMsg.t=setTimeout(()=>searchMsg.classList.add('hiddenSearch'),5200)}
function searchTokens(a){return[(a.flight||''),(a.registration||''),(a.hex||''),(a.aircraftType||'')].map(x=>String(x).trim().toUpperCase())}
function scoreSearch(a,q){const t=searchTokens(a);let score=0;for(const v of t){if(!v)continue;if(v===q)score=Math.max(score,100);else if(v.replace(/[-\s]/g,'')===q.replace(/[-\s]/g,''))score=Math.max(score,95);else if(v.startsWith(q))score=Math.max(score,70);else if(v.includes(q))score=Math.max(score,50)}return score}
function selectSearchResult(found,q){
  const key=normHex(found.hex)||`${found.lat}:${found.lon}:${found.flight}`;
  const existing=lastGood.filter(a=>(normHex(a.hex)||`${a.lat}:${a.lon}:${a.flight}`)!==key);
  lastGood=[found,...existing];
  draw(lastGood);
  mapInteraction=true;
  // Global search is a hard synchronization point: marker and map start at the same live coordinates.
  const obj=markerByHex.get(key);
  if(obj){if(obj.animFrame)cancelAnimationFrame(obj.animFrame);obj.animFrame=null;obj.marker.setLatLng([found.lat,found.lon]);}
  map.setView([found.lat,found.lon],Math.max(map.getZoom(),9),{animate:false});
  center=[found.lat,found.lon];
  selectAircraft(found);
  requestAnimationFrame(()=>requestAnimationFrame(()=>keepSelectedVisible(found,false)));
  updateStatus();
  showSearchMsg('Gefunden: '+(found.flight||found.registration||found.hex));
  clearTimeout(mapReloadTimer);
  mapReloadTimer=setTimeout(()=>{
    mapInteraction=false;
    const c=map.getCenter();center=[c.lat,c.lng];
    statusEl.textContent='Lade Flugzeuge für diesen Kartenausschnitt…';
    nextRefreshAt=Date.now()+REFRESH_MS;
    load(true);
  },700);
}
const IATA_TO_ICAO_CALLSIGN={
  QR:'QTR',LH:'DLH',AF:'AFR',BA:'BAW',KL:'KLM',LX:'SWR',OS:'AUA',EW:'EWG',
  U2:'EZY',W6:'WZZ',VY:'VLG',IB:'IBE',SK:'SAS',AY:'FIN',TP:'TAP',TK:'THY',
  EK:'UAE',EY:'ETD',SV:'SVA',MS:'MSR',A3:'AEE',LO:'LOT',AC:'ACA',UA:'UAL',
  AA:'AAL',DL:'DAL',B6:'JBU',WN:'SWA',SQ:'SIA',CX:'CPA',JL:'JAL',NH:'ANA'
};
function looksLikeAirlineFlightNumber(q){
  return /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(q)||/^[A-Z]{2,3}\d{2,4}$/.test(q);
}
function airlineFlightNumberToCallsign(q){
  const m=q.replace(/\s+/g,'').match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if(!m)return null;
  const icao=IATA_TO_ICAO_CALLSIGN[m[1]];
  if(!icao)return null;
  return icao+m[2].padStart(m[2].match(/^\d+/)?.[0]?.length<3?3:m[2].length,'0');
}
async function globalSearch(){
  const q=searchInput.value.trim().toUpperCase();if(!q)return;
  const ranked=lastGood.map(a=>({a,score:scoreSearch(a,q)})).filter(x=>x.score>0).sort((x,y)=>y.score-x.score);
  if(ranked.length){selectSearchResult(ranked[0].a,q);return}
  if(searching){showSearchMsg('Suche läuft bereits…');return}
  searching=true;const run=++searchRun;const searchBtn=document.querySelector('#searchBtn');searchBtn.disabled=true;
  clearTimeout(mapReloadTimer);if(connectionReady)nextRefreshAt=Date.now()+REFRESH_MS;
  showSearchMsg('Suche nach aktuellem Flug…');
  diagEvent('SUCHE gestartet',q);
  const compact=q.replace(/[^A-Z0-9]/g,'');
  const tries=[];
  if(/^[0-9A-F]{6}$/.test(compact))tries.push(['icao',compact.toLowerCase(),compact]);
  else if(q.includes('-'))tries.push(['reg',q,q]);
  else {
    const mappedCallsign=airlineFlightNumberToCallsign(q);
    // Fuer normale Nutzer ist die oeffentliche Flugnummer der primaere Suchbegriff.
    // Wenn eine eindeutige IATA->ICAO-Abbildung existiert, wird diese zuerst versucht.
    if(mappedCallsign&&mappedCallsign!==q)tries.push(['callsign',mappedCallsign,q]);
    tries.push(['callsign',q,q]);
    tries.push(['reg',q,q]);
  }
  let list=[],technicalErrors=0,successfulLookups=0,rateLimited=false;
  const fetchSearch=async(kind,value,display,attempt)=>{
    if(run!==searchRun)return null;
    const controller=new AbortController();searchController=controller;let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort()},REQUEST_TIMEOUT_MS);
    const started=performance.now();
    diagEvent(attempt===1?'SUCHE Request':'SUCHE Retry',`${display} → ${kind}:${value}`);
    try{
      const u=new URL('https://gregorflighttracker.val.run/');u.searchParams.set(kind,value);
      const r=await fetch(u,{cache:'no-store',signal:controller.signal});
      const ms=Math.round(performance.now()-started);
      if(r.status===429){rateLimited=true;technicalErrors++;diagEvent('SUCHE HTTP 429',`${display} · ${ms} ms`);return []}
      if(!r.ok){technicalErrors++;diagEvent('SUCHE HTTP '+r.status,`${display} · ${ms} ms`);return []}
      const d=await r.json();
      if(d?.upstream_status===429||d?.ft_upstream_status===429){rateLimited=true;technicalErrors++;diagEvent('SUCHE Upstream 429',display);return []}
      if(d?.error){technicalErrors++;diagEvent('SUCHE Fehler',`${display} · ${d.error}`);return []}
      successfulLookups++;
      const raw=(d.ac||d.aircraft||[]);
      const found=raw.map(a=>({hex:a.hex,flight:(a.flight||a.callsign||'').trim(),registration:a.r||a.registration||'',aircraftType:a.t||a.aircraft_type||'',description:a.desc||'',category:a.category||'',lon:a.lon,lat:a.lat,alt:a.alt_baro==='ground'?0:(a.alt_baro==null?null:a.alt_baro*.3048),altGeom:a.alt_geom==null?null:a.alt_geom*.3048,speed:a.gs==null?null:a.gs*.514444,track:a.track,rate:a.baro_rate==null?null:a.baro_rate*.00508,squawk:a.squawk,source:a.type||'',oat:a.oat??null,tat:a.tat??null,mach:a.mach??null,windDir:a.wd??null,windSpeed:a.ws??null,ias:a.ias??null,tas:a.tas??null})).filter(a=>a.lat!=null&&a.lon!=null);
      diagEvent('SUCHE HTTP 200',`${display} · ${found.length} Treffer · ${ms} ms`);
      return found;
    }catch(e){
      const ms=Math.round(performance.now()-started);
      technicalErrors++;
      diagEvent(timedOut?'SUCHE Timeout':'SUCHE Netzwerkfehler',`${display} · ${e?.message||String(e)} · ${ms} ms`);
      return null;
    }finally{clearTimeout(timer);if(searchController===controller)searchController=null}
  };
  try{
    for(const [kind,value,display] of tries){
      if(run!==searchRun)return;
      let found=await fetchSearch(kind,value,display,1);
      if(found===null&&run===searchRun){
        await new Promise(r=>setTimeout(r,1200));
        if(run!==searchRun)return;
        found=await fetchSearch(kind,value,display,2);
      }
      if(found&&found.length){list=found;break}
    }
    if(run!==searchRun)return;
    if(list.length){
      const best=list.map(a=>({a,score:scoreSearch(a,q)})).sort((x,y)=>y.score-x.score)[0]?.a||list[0];
      diagEvent('SUCHE Treffer',`${q} → ${best.flight||best.registration||best.hex}`);
      selectSearchResult(best,q);return;
    }
    if(successfulLookups>0){showSearchMsg('Kein aktuell empfangenes Flugzeug für „'+q+'“ gefunden.');return}
    if(rateLimited)showSearchMsg('Live-Suche kurz ausgelastet. Automatischer Versuch war ebenfalls erfolglos.');
    else showSearchMsg(technicalErrors?'Globale Suche momentan nicht erreichbar. Zwei Versuche sind fehlgeschlagen.':'Kein aktuelles Live-Signal für „'+q+'“ gefunden.');
  }finally{
    if(run===searchRun){searching=false;searchController=null;searchBtn.disabled=false;nextRefreshAt=Date.now()+REFRESH_MS;diagEvent('SUCHE beendet',q)}
  }
}
document.querySelector('#searchBtn').onclick=globalSearch;searchInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();globalSearch();searchInput.blur()}});
function setLocation(p){const ll=[p.coords.latitude,p.coords.longitude],acc=p.coords.accuracy||0;center=ll;if(locationMarker)map.removeLayer(locationMarker);if(accuracyCircle)map.removeLayer(accuracyCircle);locationMarker=L.circleMarker(ll,{radius:8,weight:3,color:'#fff',fillColor:'#1677ff',fillOpacity:1}).addTo(map).bindTooltip('Dein Standort');accuracyCircle=L.circle(ll,{radius:acc,weight:1,color:'#1677ff',fillColor:'#1677ff',fillOpacity:.10}).addTo(map);map.setView(ll,10);if(!lastGood.length)statusEl.textContent='Standort gefunden · lade Flugzeuge…';scheduleMapReload()}
function locate(){if(!navigator.geolocation){statusEl.textContent='Standort wird von diesem Browser nicht unterstützt';return}if(!lastGood.length)statusEl.textContent='Standort wird gesucht…';navigator.geolocation.getCurrentPosition(setLocation,e=>{const msg=e.code===1?'Standortzugriff nicht erlaubt':e.code===2?'Standort nicht verfügbar':'Standortsuche dauerte zu lange';statusEl.textContent=msg;notice.textContent=msg+'. Du kannst die Karte trotzdem verschieben und Live-Daten laden.';notice.classList.remove('hiddenNotice');load(true,'Standort nicht verfügbar')},{enableHighAccuracy:true,timeout:12000,maximumAge:30000})}
document.querySelector('#diagBtn').onclick=()=>{document.querySelector('#diagPanel').classList.remove('hiddenDiag');renderDiag()};document.querySelector('#diagCopy').onclick=copyDiagLog;document.querySelector('#diagClose').onclick=()=>document.querySelector('#diagPanel').classList.add('hiddenDiag');document.querySelector('#diagClear').onclick=()=>{diagLog=[];lastDiagSuccessAt=0;saveDiag();renderDiag()};
document.querySelector('#locate').onclick=locate;document.querySelector('#detailsBtn').onclick=()=>{document.querySelector('#detailPage').classList.remove('hiddenDetail')};document.querySelector('#detailBack').onclick=()=>document.querySelector('#detailPage').classList.add('hiddenDetail');document.querySelector('#detailClose').onclick=()=>document.querySelector('#detailPage').classList.add('hiddenDetail');document.querySelector('#close').onclick=()=>{sheet.classList.add('hidden');selectedHex=null;selectedAircraft=null;selectedMissingSince=0;if(trailLayer){map.removeLayer(trailLayer);trailLayer=null}if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}refreshMarkerStyles()};notice.onclick=()=>load(true,'manueller Retry');map.on('movestart zoomstart',e=>{mapInteraction=true;clearTimeout(mapReloadTimer);diagEvent('KARTE Start',e.type);/* v4.2: laufende Live-Abfragen werden durch Kartenbewegungen nicht mehr abgebrochen. */});map.on('moveend',e=>{diagEvent('KARTE Ende',e.type);scheduleMapReload()});map.on('zoomend',e=>{diagEvent('KARTE Ende',e.type);refreshMarkerStyles();scheduleMapReload()});
if('serviceWorker'in navigator){
  let refreshing=false;
  const banner=document.querySelector('#updateBanner'),nowBtn=document.querySelector('#updateNow'),laterBtn=document.querySelector('#updateLater');
  const showUpdate=reg=>{if(!reg?.waiting)return;banner.classList.remove('hiddenUpdate');nowBtn.onclick=()=>{nowBtn.disabled=true;nowBtn.textContent='Aktualisiere…';reg.waiting.postMessage({type:'SKIP_WAITING'})};laterBtn.onclick=()=>banner.classList.add('hiddenUpdate')};
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(refreshing)return;refreshing=true;location.reload()});
  navigator.serviceWorker.register('./sw.js?v=41').then(reg=>{
    if(reg.waiting)showUpdate(reg);
    reg.addEventListener('updatefound',()=>{const w=reg.installing;if(!w)return;w.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)showUpdate(reg)})});
    reg.update();
    setInterval(()=>reg.update().catch(()=>{}),10*60*1000);
  }).catch(()=>{});
}
setConnectingUi();diagEvent('APP gestartet',`visibility=${document.visibilityState}`);setTimeout(locate,500);let lastSchedulerLog=0;setInterval(()=>{const now=Date.now();if(connectionReady&&document.visibilityState==='visible'&&!loading&&!searching&&now>=nextRefreshAt){diagEvent('TIMER fällig',`Verspätung ${Math.max(0,now-nextRefreshAt)} ms`);load(false,'15-s-Scheduler')}else if(now-lastSchedulerLog>30000){lastSchedulerLog=now;diagEvent('TIMER heartbeat',`visible=${document.visibilityState} · loading=${loading} · search=${searching} · Rest ${Math.max(0,nextRefreshAt-now)} ms`)}},250);setInterval(()=>{if(!connectionReady){setConnectingUi();return}if(lastGood.length&&!loading)updateStatus();const left=Math.max(0,nextRefreshAt-Date.now());const sec=Math.max(0,Math.ceil(left/1000));countdownEl.textContent=loading?'↻':(sec||'0');refreshRing.style.setProperty('--p',loading?'0deg':`${Math.min(360,Math.max(0,(1-left/REFRESH_MS)*360))}deg`)},200);document.addEventListener('visibilitychange',()=>{diagEvent('VISIBILITY',document.visibilityState);if(document.visibilityState==='visible'){if(connectionReady)nextRefreshAt=Date.now();if(!searching)load(true,'App wieder sichtbar')}});window.addEventListener('focus',()=>diagEvent('WINDOW focus'));window.addEventListener('blur',()=>diagEvent('WINDOW blur'));window.addEventListener('pageshow',e=>diagEvent('PAGE show',e.persisted?'bfcache':'normal'));window.addEventListener('pagehide',e=>diagEvent('PAGE hide',e.persisted?'bfcache':'normal'));
