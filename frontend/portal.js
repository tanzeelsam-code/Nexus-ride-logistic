(() => {
  'use strict';
  const admin = location.pathname.includes('admin');
  const driver = location.pathname.includes('driver-register');
  const prefix = admin ? 'nexora_ops' : driver ? 'nexora_driver' : 'nexora_customer';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let currentId = null, timer;
  const set = (key,value) => value == null ? sessionStorage.removeItem(prefix+'_'+key) : sessionStorage.setItem(prefix+'_'+key,value);
  const get = key => sessionStorage.getItem(prefix+'_'+key);
  function save(data) { set('token',data.token);set('refresh',data.refresh_token);set('name',[data.user.first_name,data.user.last_name].join(' ')); }
  function message(id,error) { const el=$(id);if(el)el.textContent=error.message || String(error); }
  async function api(path,body,method,retry=true) {
    const token=get('token');
    const response=await fetch('/api/v1'+path,{method:method || (body?'POST':'GET'),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(response.status===401 && retry && get('refresh') && !path.startsWith('/auth/')) {
      try { const refreshed=await api('/auth/refresh',{refresh_token:get('refresh')},'POST',false);set('token',refreshed.token);set('refresh',refreshed.refresh_token);return api(path,body,method,false); } catch { signOut(false);throw new Error('Your session expired. Please sign in again.'); }
    }
    if(response.status===401 && !path.startsWith('/auth/')) signOut(false);
    if(!response.ok)throw new Error(data.error==='Validation failed' ? Object.entries(data.details?.fieldErrors || {}).map(([key,v])=>key+': '+v.join(', ')).join('\n') || data.error : data.error || 'Request failed');
    return data;
  }
  async function busy(form,action) { const button=form.querySelector('button[type="submit"],button:not([type="button"])');if(button)button.disabled=true;try{await action();}finally{if(button)button.disabled=false;} }
  function signOut(revoke=true) { if(revoke)api('/auth/logout',{}).catch(()=>{});['token','refresh','name','trip'].forEach(k=>set(k,null));clearInterval(timer);if($('account'))$('account').hidden=true;if($('auth'))$('auth').hidden=false; }
  $('login')?.addEventListener('submit',e=>{e.preventDefault();busy(e.target,async()=>{message('login-error','');try{const data=await api('/auth/login',Object.fromEntries(new FormData(e.target)));if(admin?!['admin','ops'].includes(data.user.role):data.user.role!=='customer')throw new Error('Use a '+(admin?'admin':'customer')+' account on this page.');save(data);e.target.reset();await start();}catch(err){message('login-error',err);}});});
  $('registration')?.addEventListener('submit',e=>{e.preventDefault();busy(e.target,async()=>{message('message','');try{const body=Object.fromEntries(new FormData(e.target));if(driver){body.vehicle={};for(const key of ['plate_number','make','model','year','color','vehicle_type']){body.vehicle[key]=key==='year'?Number(body[key]):body[key];delete body[key];}}const data=await api(driver?'/drivers/register':'/auth/register',body);save(data);e.target.reset();if(driver){e.target.hidden=true;$('success').hidden=false;}else await start();}catch(err){message('message',err);}});});
  $('registration')?.querySelector('[name="year"]')?.setAttribute('max',String(new Date().getFullYear()+1));
  $('logout')?.addEventListener('click',()=>signOut());
  $('refresh')?.addEventListener('click',()=>refresh().catch(err=>message(admin?'message':'ride-error',err)));
  $('locate')?.addEventListener('click',()=>{
    if(!navigator.geolocation)return message('ride-error','Location is unavailable. Enter pickup coordinates manually.');
    navigator.geolocation.getCurrentPosition(position=>{const form=$('ride');form.elements.pickup_lat.value=position.coords.latitude;form.elements.pickup_lng.value=position.coords.longitude;message('ride-error','Pickup coordinates updated. Enter your pickup address.');},()=>message('ride-error','Location permission was denied or unavailable. Enter pickup coordinates manually.'),{enableHighAccuracy:true,timeout:15000});
  });
  $('ride')?.addEventListener('submit',e=>{e.preventDefault();busy(e.target,async()=>{message('ride-error','');try{const body=Object.fromEntries(new FormData(e.target));for(const key of ['pickup_lat','pickup_lng','dropoff_lat','dropoff_lng'])body[key]=Number(body[key]);body.payment_method='cash';body.service_type='taxi';const data=await api('/trips',body);currentId=data.trip.id;set('trip',currentId);await showTrip();await refresh();}catch(err){message('ride-error',err);}});});
  async function showTrip() {
    if(!currentId)return;
    const {trip:t}=await api('/trips/'+encodeURIComponent(currentId));
    const active=['requested','searching','accepted','driver_en_route','arrived','in_progress'].includes(t.status);
    $('current').hidden=false;
    $('current').innerHTML=`<h2>Your ride · ${esc(t.status.replaceAll('_',' '))}</h2><p>${esc(t.pickup_address)} → ${esc(t.dropoff_address)}</p><dl><dt>Pickup PIN · share only when your driver arrives</dt><dd>${esc(t.pickup_otp || '—')}</dd><dt>Driver</dt><dd>${esc(t.driver_name || 'Searching for a nearby online driver')}${t.plate_number?' · '+esc(t.plate_number):''}</dd><dt>Fare</dt><dd>${esc(t.currency || 'USD')} ${esc(t.total_fare || '—')}</dd></dl>${active && t.status!=='in_progress'?'<button id="cancel" class="secondary">Cancel ride</button>':''}${t.status==='failed'?'<p>No available driver was found. Ask an approved driver to go online near the pickup, then request again.</p>':''}`;
    $('cancel')?.addEventListener('click',async e=>{e.target.disabled=true;try{await api('/trips/'+encodeURIComponent(currentId)+'/cancel',{});await showTrip();await refresh();}catch(err){message('ride-error',err);e.target.disabled=false;}});
    if(!active){clearInterval(timer);timer=null;}
    else if(!timer)timer=setInterval(()=>showTrip().catch(err=>message('ride-error',err)),5000);
  }
  async function refresh() {
    if(admin){const data=await api('/admin/drivers');$('drivers').innerHTML=data.drivers.length?data.drivers.map(d=>`<article class="row"><strong>${esc(d.first_name)} ${esc(d.last_name)}</strong><p>${esc(d.email)} · ${esc(d.phone)}</p><p>${d.onboarding_completed?'Approved':'Pending approval'} · ${esc(d.status)}</p>${!d.onboarding_completed?`<button data-approve="${esc(d.id)}">Approve driver</button>`:''}</article>`).join(''):'No driver registrations yet.';return;}
    const data=await api('/trips');$('history').innerHTML=data.trips.length?data.trips.map(t=>`<article class="row"><strong>${esc(t.status.replaceAll('_',' '))}</strong><p>${esc(t.pickup_address)} → ${esc(t.dropoff_address)}</p><button class="secondary" data-trip="${esc(t.id)}">View ride</button></article>`).join(''):'You have no rides yet.';
    if(!currentId){const active=data.trips.find(t=>['requested','searching','accepted','driver_en_route','arrived','in_progress'].includes(t.status));if(active){currentId=active.id;set('trip',currentId);await showTrip();}}
  }
  $('drivers')?.addEventListener('click',async e=>{const button=e.target.closest('[data-approve]');if(!button)return;button.disabled=true;try{await api('/admin/drivers/'+encodeURIComponent(button.dataset.approve)+'/approve',{});message('message','Driver approved. They can now go online in the driver app.');await refresh();}catch(err){message('message',err);button.disabled=false;}});
  $('history')?.addEventListener('click',async e=>{const button=e.target.closest('[data-trip]');if(!button)return;currentId=button.dataset.trip;set('trip',currentId);clearInterval(timer);timer=null;try{await showTrip();}catch(err){message('ride-error',err);}});
  async function start(){ $('auth').hidden=true;$('account').hidden=false;$('name').textContent=get('name') || 'your account';await refresh();if(!admin){currentId=get('trip') || currentId;if(currentId)await showTrip();} }
  if(!driver && get('token'))start().catch(err=>{if($('account').hidden)message('login-error',err);else message(admin?'message':'ride-error',err);});
})();
