(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  async function send(path, body) {
    const response = await fetch('/api/v1/auth/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000), cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(Object.values(data.details?.fieldErrors || {}).flat().join(' ') || data.error || 'Please try again.');
    return data;
  }
  function bind(id, status, action) {
    $(id).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget, button = form.querySelector('button');
      button.disabled = true; $(status).textContent = '';
      try { await action(Object.fromEntries(new FormData(form)), form); }
      catch (error) { $(status).textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  bind('create-code', 'create-status', async (body, form) => {
    $('code-result').hidden = true; $('recovery-code').value = '';
    const data = await send('recovery-code', body);
    form.elements.password.value = '';
    $('recovery-code').value = data.recovery_code;
    $('code-result').hidden = false; $('create-status').textContent = data.message;
  });
  bind('recover', 'recover-status', async (body, form) => {
    if (body.new_password !== body.confirm_password) throw new Error('The passwords do not match.');
    delete body.confirm_password;
    const data = await send('recover', body);
    form.reset(); $('recover-status').textContent = data.message;
  });
  $('copy-code').onclick = async () => {
    try { await navigator.clipboard.writeText($('recovery-code').value); $('create-status').textContent = 'Copied. Save this code privately before leaving.'; }
    catch { $('recovery-code').select(); $('create-status').textContent = 'Select and copy the code manually.'; }
  };
  $('hide-code').onclick = () => { $('recovery-code').value = ''; $('code-result').hidden = true; $('create-status').textContent = 'Keep your saved code private.'; };
})();
