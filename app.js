const map=L.map('map',{zoomControl:false}).setView([48.0,10.0],7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap'}).addTo(map);
L.control.zoom({position:'bottomright'}).addTo(map);
const statusEl=document.querySelector('#status'),sheet=document.querySelector('#sheet'),notice=document.querySelector('#notice');
let markerByHex=new Map(),center=[48,10],locationMarker=null,accuracyCircle=null,loading=false,lastLoad=0,lastGood=[],lastSuccess=0,failCount=0,selectedHex=null,selectedAircraft=null,selectedMissingSince=0,trailLayer=null,trailByHex=new Map(),routeLayer=null;
let activeController=null,requestSeq=0,latestAppliedSeq=0,mapInteraction=false,mapReloadTimer=null;
const enrichCache=new Map(),enrichPending=new Map();
const REFRESH_MS=15000, MOVE_MS=14000;
let nextRefreshAt=Date.now()+REFRESH_MS;const countdownEl=document.querySelector('#countdown'),refreshRing=document.querySelector('#refreshRing');
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
function drawRoute(a){if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}const r=a.enrichment?.flightroute;if(!r?.destination||a.lat==null||a.lon==null)return;const lat=Number(r.destination.latitude),lon=Number(r.destination.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lon))return;const dest=[lat,lon],code=airportLabel(r.destination)||'Ziel';const line=L.polyline([[a.lat,a.lon],dest],{color:'#2f9bff',weight:4,opacity:.9,dashArray:'9 8'});const dot=L.circleMarker(dest,{radius:5,weight:2,color:'#fff',fillColor:'#2f9bff',fillOpacity:1}).bindTooltip(code,{permanent:true,direction:'top',className:'route-label'});routeLayer=L.layerGroup([line,dot]).addTo(map)}
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
  const o=airportLabel(r.origin),d=airportLabel(r.destination);const routeText=o&&d?`${o} → ${d}`:o?`${o} → Ziel unbekannt`:'Route nicht verfügbar';
  const routeNames=o&&d?`${r.origin?.municipality||r.origin?.name||''} → ${r.destination?.municipality||r.destination?.name||''}`:'';
  const routeBox=document.querySelector('.routeBox');document.querySelector('#route').textContent=routeText;routeBox.classList.toggle('noRoute',!o&&!d);document.querySelector('#routeNames').textContent=routeNames;
  document.querySelector('#detailRoute').textContent=routeText;document.querySelector('#detailRouteNames').textContent=routeNames;
  const photo=ac.url_photo||ac.url_photo_thumbnail||'';const img=document.querySelector('#detailPhoto');if(photo){img.src=photo;img.classList.remove('hiddenPhoto')}else{img.removeAttribute('src');img.classList.add('hiddenPhoto')}
  document.querySelector('#alt').textContent=alt;document.querySelector('#speed').textContent=speed;document.querySelector('#heading').textContent=heading;document.querySelector('#altDetail').textContent=alt;document.querySelector('#speedDetail').textContent=speed;document.querySelector('#headingDetail').textContent=heading;document.querySelector('#rate').textContent=a.rate==null?'—':Math.abs(Math.round(a.rate*60))+' m/min '+(a.rate>.5?'↑':a.rate<-.5?'↓':'→');
  const facts=[]; if(a.oat!=null)facts.push(['Außentemperatur',celsius(a.oat),'🌡️']); if(a.windDir!=null&&a.windSpeed!=null)facts.push(['Wind',windText(a.windDir,a.windSpeed),'💨']); if(a.mach!=null)facts.push(['Reisegeschwindigkeit',machText(a.mach),'🚀']); if(a.altGeom!=null)facts.push(['Geometrische Höhe',metres(a.altGeom),'📏']);
  const factsEl=document.querySelector('#interestingFacts'); factsEl.innerHTML=facts.map(([k,v,i])=>`<div class="fact"><span>${i}</span><small>${k}</small><strong>${v}</strong></div>`).join(''); factsEl.classList.toggle('hiddenFacts',!facts.length);
  document.querySelector('#tech').textContent=[a.hex&&('ICAO '+a.hex.toUpperCase()),a.squawk&&('Squawk '+a.squawk),a.source&&('Positionsquelle '+a.source.toUpperCase()),a.tas!=null&&('TAS '+Math.round(a.tas*1.852)+' km/h'),a.ias!=null&&('IAS '+Math.round(a.ias*1.852)+' km/h'),ac.registered_owner&&('Halter '+ac.registered_owner)].filter(Boolean).join(' · ')||'Live-Positionsdaten';drawRoute(a)
}
function addTrailPoint(a){if(!a.hex||a.lat==null||a.lon==null)return;let pts=trailByHex.get(a.hex)||[];const last=pts[pts.length-1];if(!last||Math.abs(last[0]-a.lat)>0.00005||Math.abs(last[1]-a.lon)>0.00005){pts.push([a.lat,a.lon]);if(pts.length>240)pts=pts.slice(-240);trailByHex.set(a.hex,pts)}if(a.hex===selectedHex)drawTrail(a.hex)}
function drawTrail(hex){if(trailLayer){map.removeLayer(trailLayer);trailLayer=null}const pts=trailByHex.get(hex)||[];if(pts.length>1)trailLayer=L.polyline(pts,{color:'#ff9f0a',weight:3,opacity:.8}).addTo(map);if(selectedAircraft)drawRoute(selectedAircraft)}
function selectAircraft(a){selectedHex=a.hex||null;selectedAircraft=a;selectedMissingSince=0;fillDetails(a);sheet.classList.remove('detail');sheet.classList.add('compact');sheet.classList.remove('hidden');drawTrail(selectedHex);refreshMarkerStyles();requestAnimationFrame(()=>keepSelectedVisible(a,true));enrichAircraft(a).then(e=>{if(e&&selectedHex===a.hex){a.enrichment=e;selectedAircraft=a;fillDetails(a);requestAnimationFrame(()=>keepSelectedVisible(a,true))}})}
const svgPlane=`<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M29 3h6l3 23 19 10v6l-19-4-2 15 8 5v4l-12-2-12 2v-4l8-5-2-15-19 4v-6l19-10z"/></svg>`;
const svgHeli=`<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 13h48v4H35v8c8 1 14 7 15 15h7v5h-8c-2 7-8 11-16 11H20c-7 0-12-5-12-12 0-8 6-14 14-14h7V17H8zm14 23c-5 0-8 3-8 8 0 4 3 6 7 6h11V36zm16 0v14c4-1 7-4 7-8s-3-6-7-6z"/><path d="M46 24h4v9h-4zM50 27h10v4H50z"/></svg>`;
const svgLight=`<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M29 6h6l2 22 20 7v6l-20-2-2 13 8 4v4l-11-2-11 2v-4l8-4-2-13-20 2v-6l20-7z"/></svg>`;
function craftKind(a){const d=(a.description||'').toUpperCase(),t=(a.aircraftType||'').toUpperCase();if(d.includes('ROTOR')||d.includes('HELICOPTER')||/^(R22|R44|R66|EC|H1[2345]|AS3|B06|B4|S76|A109|A139|A169|A189)/.test(t))return'heli';if(d.includes('LIGHT')||d.includes('ULTRALIGHT')||/^(C1|C2|C3|C4|PA|SR2|DA|P28|BE|M20)/.test(t))return'light';return'plane'}
function iconPx(){const z=map.getZoom();return z<=8?20:z<=10?23:z<=12?26:29}
function craftIcon(a,selected=false){const kind=craftKind(a),svg=kind==='heli'?svgHeli:kind==='light'?svgLight:svgPlane,px=iconPx();return L.divIcon({className:'craft-marker',html:`<div class="craft ${kind}${selected?' selected':''}" style="--craft-size:${px}px;transform:rotate(${a.track||0}deg)">${svg}</div>`,iconSize:[px,px],iconAnchor:[px/2,px/2]})}
function refreshMarkerStyles(){for(const [hex,obj] of markerByHex){obj.marker.setIcon(craftIcon(obj.aircraft,hex===selectedHex));if(hex===selectedHex)obj.marker.setZIndexOffset(2000);else obj.marker.setZIndexOffset(0)}}
function keepSelectedVisible(a,animate=false){if(!a||a.lat==null||a.lon==null)return;const p=map.latLngToContainerPoint([a.lat,a.lon]);const sheetH=sheet.classList.contains('hidden')?0:sheet.getBoundingClientRect().height;const top=92,bottom=window.innerHeight-sheetH-18;const targetY=top+(bottom-top)*.48;if(p.y<top||p.y>bottom||animate){const delta=p.y-targetY;const centerPoint=map.latLngToContainerPoint(map.getCenter());const newCenter=map.containerPointToLatLng([centerPoint.x,centerPoint.y+delta]);map.panTo(newCenter,{animate})}}
function animateMarker(obj,a){
  if(obj.animFrame)cancelAnimationFrame(obj.animFrame);
  const from=obj.marker.getLatLng(),to=L.latLng(a.lat,a.lon);
  if(!from||!Number.isFinite(from.lat)||Math.abs(from.lat-to.lat)+Math.abs(from.lng-to.lng)>8){obj.marker.setLatLng(to);return}
  const started=performance.now();
  const step=now=>{const t=Math.min(1,(now-started)/MOVE_MS),ease=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;obj.marker.setLatLng([from.lat+(to.lat-from.lat)*ease,from.lng+(to.lng-from.lng)*ease]);if(t<1)obj.animFrame=requestAnimationFrame(step);else obj.animFrame=null};
  obj.animFrame=requestAnimationFrame(step)
}
function draw(list){lastGood=list;const next=new Map();for(const a of list){if(a.lat==null||a.lon==null)continue;addTrailPoint(a);const key=a.hex||`${a.lat}:${a.lon}:${a.flight}`;let obj=markerByHex.get(key);if(obj){obj.aircraft=a;animateMarker(obj,a);obj.marker.setIcon(craftIcon(a,key===selectedHex))}else{const m=L.marker([a.lat,a.lon],{icon:craftIcon(a,key===selectedHex),keyboard:false,riseOnHover:true}).addTo(map);obj={marker:m,aircraft:a};m.on('click',()=>selectAircraft(obj.aircraft))}next.set(key,obj)}if(selectedHex&&!next.has(selectedHex)&&markerByHex.has(selectedHex)){if(!selectedMissingSince)selectedMissingSince=Date.now();if(Date.now()-selectedMissingSince<20000){const held=markerByHex.get(selectedHex);held.marker.setIcon(craftIcon(held.aircraft,true));held.marker.setZIndexOffset(2000);next.set(selectedHex,held)}}for(const [key,obj] of markerByHex)if(!next.has(key)){if(obj.animFrame)cancelAnimationFrame(obj.animFrame);map.removeLayer(obj.marker);}markerByHex=next;if(selectedHex&&markerByHex.has(selectedHex)){const fresh=markerByHex.get(selectedHex).aircraft;if(list.some(a=>a.hex===selectedHex)){selectedMissingSince=0;fresh.enrichment=selectedAircraft?.enrichment;selectedAircraft=fresh;fillDetails(selectedAircraft)}markerByHex.get(selectedHex).marker.setZIndexOffset(2000)}else if(selectedHex&&selectedMissingSince&&Date.now()-selectedMissingSince>=20000){selectedHex=null;selectedAircraft=null;selectedMissingSince=0;sheet.classList.add('hidden');if(trailLayer){map.removeLayer(trailLayer);trailLayer=null}if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}}lastSuccess=Date.now();failCount=0;notice.classList.add('hiddenNotice');updateStatus()}
function queryForCurrentMap(){
  const b=map.getBounds(),c=b.getCenter();
  const corners=[b.getNorthWest(),b.getNorthEast(),b.getSouthWest(),b.getSouthEast()];
  let maxM=0; for(const x of corners)maxM=Math.max(maxM,map.distance(c,x));
  // adsb.lol point endpoint accepts nautical miles. Add a small margin, capped at 250 NM.
  const radius=Math.min(250,Math.max(10,Math.ceil((maxM/1852)*1.12)));
  return {lat:c.lat,lon:c.lng,radius};
}
async function fetchProxy(signal,query){const u=new URL('https://gregorbuerger--ddcc2c7abcfe11f182391607ee4eb77e.web.val.run/');u.searchParams.set('lat',query.lat.toFixed(4));u.searchParams.set('lon',query.lon.toFixed(4));u.searchParams.set('radius',String(query.radius));const r=await fetch(u,{cache:'no-store',signal});if(!r.ok)throw Error('Flight Tracker API '+r.status);const d=await r.json();return(d.ac||[]).map(a=>({hex:a.hex,flight:(a.flight||a.callsign||'').trim(),registration:a.r||'',aircraftType:a.t||'',description:a.desc||'',category:a.category||'',lon:a.lon,lat:a.lat,alt:a.alt_baro==='ground'?0:(a.alt_baro==null?null:a.alt_baro*.3048),altGeom:a.alt_geom==null?null:a.alt_geom*.3048,speed:a.gs==null?null:a.gs*.514444,track:a.track,rate:a.baro_rate==null?null:a.baro_rate*.00508,squawk:a.squawk,source:a.type||'',oat:a.oat??null,tat:a.tat??null,mach:a.mach??null,windDir:a.wd??null,windSpeed:a.ws??null,ias:a.ias??null,tas:a.tas??null}))}
async function load(force=false){
  if(mapInteraction&&!force)return;
  if(!force&&Date.now()-lastLoad<4000)return;
  const seq=++requestSeq,query=queryForCurrentMap();
  if(activeController)activeController.abort();
  const controller=new AbortController(); activeController=controller;
  const timer=setTimeout(()=>controller.abort(),12000);
  loading=true;lastLoad=Date.now();refreshRing.classList.add('loading');
  if(!lastGood.length)statusEl.textContent='Live-Flugzeuge werden geladen…';
  try{
    const list=await fetchProxy(controller.signal,query);
    if(seq!==requestSeq)return; // stale response from an older map area
    latestAppliedSeq=seq;draw(list);
  }catch(e){
    if(e?.name==='AbortError'){return;}
    if(seq!==requestSeq)return;
    console.warn(e);failCount++;
    if(lastGood.length){updateStatus();if(failCount>=3){notice.textContent='Live-Aktualisierung momentan unterbrochen. Die zuletzt geladenen Flugzeuge bleiben sichtbar.';notice.classList.remove('hiddenNotice')}}
    else{statusEl.textContent='Live-Daten nicht erreichbar';notice.textContent='Die Live-Flugdaten antworten gerade nicht. Tippe hier für einen neuen Versuch.';notice.classList.remove('hiddenNotice');setTimeout(()=>{if(!lastGood.length)load(true)},6000)}
  }finally{
    clearTimeout(timer);
    if(seq===requestSeq){loading=false;activeController=null;refreshRing.classList.remove('loading');nextRefreshAt=Date.now()+REFRESH_MS}
  }
}
function scheduleMapReload(){
  clearTimeout(mapReloadTimer);
  mapReloadTimer=setTimeout(()=>{mapInteraction=false;const c=map.getCenter();center=[c.lat,c.lng];statusEl.textContent='Lade Flugzeuge für diesen Kartenausschnitt…';nextRefreshAt=Date.now()+REFRESH_MS;load(true)},700);
}
function setLocation(p){const ll=[p.coords.latitude,p.coords.longitude],acc=p.coords.accuracy||0;center=ll;if(locationMarker)map.removeLayer(locationMarker);if(accuracyCircle)map.removeLayer(accuracyCircle);locationMarker=L.circleMarker(ll,{radius:8,weight:3,color:'#fff',fillColor:'#1677ff',fillOpacity:1}).addTo(map).bindTooltip('Dein Standort');accuracyCircle=L.circle(ll,{radius:acc,weight:1,color:'#1677ff',fillColor:'#1677ff',fillOpacity:.10}).addTo(map);map.setView(ll,10);if(!lastGood.length)statusEl.textContent='Standort gefunden · lade Flugzeuge…';setTimeout(()=>load(true),250)}
function locate(){if(!navigator.geolocation){statusEl.textContent='Standort wird von diesem Browser nicht unterstützt';return}if(!lastGood.length)statusEl.textContent='Standort wird gesucht…';navigator.geolocation.getCurrentPosition(setLocation,e=>{const msg=e.code===1?'Standortzugriff nicht erlaubt':e.code===2?'Standort nicht verfügbar':'Standortsuche dauerte zu lange';statusEl.textContent=msg;notice.textContent=msg+'. Du kannst die Karte trotzdem verschieben und Live-Daten laden.';notice.classList.remove('hiddenNotice');load(true)},{enableHighAccuracy:true,timeout:12000,maximumAge:30000})}
document.querySelector('#locate').onclick=locate;document.querySelector('#detailsBtn').onclick=()=>{document.querySelector('#detailPage').classList.remove('hiddenDetail')};document.querySelector('#detailBack').onclick=()=>document.querySelector('#detailPage').classList.add('hiddenDetail');document.querySelector('#detailClose').onclick=()=>document.querySelector('#detailPage').classList.add('hiddenDetail');document.querySelector('#close').onclick=()=>{sheet.classList.add('hidden');selectedHex=null;selectedAircraft=null;selectedMissingSince=0;if(trailLayer){map.removeLayer(trailLayer);trailLayer=null}if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}refreshMarkerStyles()};notice.onclick=()=>load(true);map.on('movestart zoomstart',()=>{mapInteraction=true;clearTimeout(mapReloadTimer);if(activeController)activeController.abort()});map.on('moveend',scheduleMapReload);map.on('zoomend',()=>{refreshMarkerStyles();scheduleMapReload()});
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').then(r=>r.update()).catch(()=>{});
setTimeout(locate,500);setInterval(()=>{if(document.visibilityState==='visible'&&!loading&&Date.now()>=nextRefreshAt)load()},250);setInterval(()=>{if(lastGood.length&&!loading)updateStatus();const left=Math.max(0,nextRefreshAt-Date.now());const sec=Math.max(0,Math.ceil(left/1000));countdownEl.textContent=sec||'0';refreshRing.style.setProperty('--p',`${Math.min(360,Math.max(0,(1-left/REFRESH_MS)*360))}deg`)},200);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){nextRefreshAt=Date.now();load(true)}});
