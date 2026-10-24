(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = (value,currency='USD') => new Intl.NumberFormat(undefined,{style:'currency',currency}).format(Number(value));
  let quote, draft, timer, available = false, busy = false, version = 0, quoteVersion = 0;
  const points = { pickup: null, dropoff: null }, searchVersion = {pickup:0,dropoff:0};
  const session = NexoraSession('nexora_customer', signedOut);
  const request = (path,body,headers) => session.api(path,{method:body === undefined ? 'GET':'POST', ...(body === undefined ? {}:{body}),headers});
  function signedOut() { clearInterval(timer); version++; $('account').hidden=true; $('login').hidden=false; $('history').replaceChildren(); }
  function invalidate() { quoteVersion++; quote=null; draft=null; $('quote').hidden=true; $('quote-placeholder').hidden=false; }
  async function task(button,status,fn) {
    button.disabled=true; $(status).textContent='';
    try { await fn(); } catch(error) { $(status).textContent=error.message; }
    finally { button.disabled=false; }
  }
  for (const kind of ['pickup','dropoff']) {
    $(kind+'-address').addEventListener('input',()=>{ points[kind]=null; searchVersion[kind]++; $(kind+'-results').replaceChildren(); invalidate(); });
    $('search-'+kind).onclick = () => task($('search-'+kind),'delivery-error',async()=>{
      const sequence=++searchVersion[kind];
      const {places} = await request('/places/search?q='+encodeURIComponent($(kind+'-address').value.trim()));
      if(sequence!==searchVersion[kind]) return;
      $(kind+'-results').replaceChildren();
      for(const place of places) {
        const button=document.createElement('button'); button.type='button'; button.className='secondary'; button.textContent=place.address;
        button.onclick=()=>{points[kind]=place; $(kind+'-address').value=place.address; $(kind+'-results').replaceChildren(); invalidate();};
        $(kind+'-results').append(button);
      }
      if(!places.length) $(kind+'-results').textContent='No addresses found. Try a nearby street or landmark.';
    });
  }
  $('delivery').addEventListener('input',invalidate);
  $('delivery').addEventListener('submit',event=>{
    event.preventDefault();
    task($('estimate'),'delivery-error',async()=>{
      if(!available) throw new Error('New bookings are not available yet. Existing deliveries remain accessible.');
      if(!points.pickup || !points.dropoff) throw new Error('Search and select both addresses first.');
      const body=Object.fromEntries(new FormData($('delivery')));
      body.cargo_weight_kg=Number(body.cargo_weight_kg); body.is_fragile=$('delivery').elements.is_fragile.checked;
      for(const kind of ['pickup','dropoff']) { body[kind+'_lat']=points[kind].lat; body[kind+'_lng']=points[kind].lng; body[kind+'_address']=points[kind].address; }
      const sequence=++quoteVersion;
      $('delivery').querySelectorAll('input').forEach(input=>input.disabled=true);
      let result;
      try { result=await request('/deliveries/estimate',body); }
      finally { $('delivery').querySelectorAll('input').forEach(input=>input.disabled=false); }
      if(sequence!==quoteVersion) return;
      quote=result; draft=body;
      const price=quote.price_estimate;
      $('fare').textContent=money(price.total_fare,price.currency);
      $('quote-detail').textContent=`${body.pickup_address} → ${body.dropoff_address}. Quote valid until ${new Date(quote.expires_at).toLocaleTimeString()}.`;
      $('quote').hidden=false; $('quote-placeholder').hidden=true;
    });
  });
  $('confirm').onclick=()=>task($('confirm'),'booking-message',async()=>{
    if(!quote || Date.now()>=new Date(quote.expires_at).getTime()) {invalidate(); throw new Error('Your quote expired. Please check the fare again.');}
    const body={...draft,quote_token:quote.quote_token};
    const serialized=JSON.stringify(body);
    let pending;
    try { pending=JSON.parse(session.get('pending_delivery')); } catch {}
    if(pending?.body!==serialized) {pending={body:serialized,key:crypto.randomUUID()}; session.set('pending_delivery',JSON.stringify(pending));}
    const {delivery}=await request('/deliveries',body,{'Idempotency-Key':pending.key});
    session.set('pending_delivery',null); invalidate();
    $('booking-message').textContent=`Delivery ${delivery.delivery_number} requested. Your pickup and delivery PINs are below.`;
    await history();
  });
  async function history() {
    if(busy) return; busy=true; const current=version;
    try {
      const {deliveries}=await request('/deliveries'); if(current!==version) return;
      $('history-error').textContent='';
      $('history').innerHTML=deliveries.length ? deliveries.map(d=>{
        const active=!['delivered','cancelled','failed','returned'].includes(d.status);
        const slug=String(d.tracking_url||'').split('/').pop();
        const track=/^[a-f0-9]{24}$/.test(slug)?`<a href="/track/${slug}">Open tracking link</a>`:'';
        return `<article class="card"><h3>${esc(d.delivery_number)}</h3><p>${esc(d.pickup_address)} → ${esc(d.dropoff_address)}</p><p>${esc(d.status.replace(/_/g,' '))} · ${money(d.total_fare,d.currency)}</p><p>${d.payment_status==='captured'?'Paid in cash · Receipt '+esc('PAY-'+d.delivery_number):active?'Cash due from recipient on delivery':'Payment status: '+esc(d.payment_status)}</p>${active?`<p>Pickup PIN: <strong>${esc(d.pickup_otp)}</strong> · Delivery PIN: <strong>${esc(d.dropoff_otp)}</strong></p><p>Share each PIN only with the person handing over or receiving the package.</p>`:''}${d.dropoff_recipient_name?`<p>Received by ${esc(d.dropoff_recipient_name)} on ${esc(new Date(d.delivered_at).toLocaleString())}</p>`:''}${track}${['pending','pickup_scheduled'].includes(d.status)?` <button class="secondary" data-cancel="${esc(d.id)}">Cancel delivery</button>`:''}</article>`;
      }).join(''):'<p>No deliveries yet. Your requests and receipts will appear here.</p>';
    } catch(error) { if(current===version) $('history-error').textContent=error.message; }
    finally { busy=false; }
  }
  $('history').onclick=event=>{const button=event.target.closest('[data-cancel]'); if(!button || !confirm('Cancel this delivery?')) return; task(button,'history-error',async()=>{await request('/deliveries/'+button.dataset.cancel+'/cancel',{}); await history();});};
  $('refresh').onclick=history;
  async function start() {
    $('login').hidden=true; $('account').hidden=false; $('name').textContent=session.get('name')||'there';
    try { const config=await request('/config'); available=config.booking_available; $('estimate').disabled=!available; $('availability').textContent=available?'':'New bookings are not available yet. You can still follow existing deliveries.'; }
    catch(error) { $('availability').textContent=error.message; }
    await history(); clearInterval(timer); timer=setInterval(()=>{if(!document.hidden) history();},10000);
  }
  $('login').onsubmit=event=>{event.preventDefault(); task($('login').querySelector('button'),'login-error',async()=>{
    const data=await request('/auth/login',Object.fromEntries(new FormData($('login'))));
    session.save(data); if(data.user.role!=='customer') {session.logout(); throw new Error('Use your customer account to book a delivery.');}
    $('login').reset(); await start();
  });};
  $('logout').onclick=()=>{session.logout(); signedOut();};
  if(session.get('token')) start();
})();
