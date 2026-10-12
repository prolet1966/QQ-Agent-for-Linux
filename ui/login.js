const $ = id => document.getElementById(id);
let oldPassword = '';
async function request(action, body) {
  const response = await fetch(`/api/auth/${action}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function changeView() { $('login').hidden = true; $('change').hidden = false; $('hint').textContent = '请设置至少 12 个字符的控制台密码。'; }
async function submit(form, task) {
  form.querySelector('button').disabled = true; $('error').textContent = '';
  try { await task(); } catch (error) { $('error').textContent = error.message; }
  finally { form.querySelector('button').disabled = false; }
}
$('login').addEventListener('submit', event => { event.preventDefault(); submit($('login'), async () => {
  oldPassword = $('password').value;
  const result = await request('login', { password: oldPassword });
  if (result.mustChangePassword || location.search === '?change') changeView(); else location.assign('/');
}); });
$('change').addEventListener('submit', event => { event.preventDefault(); submit($('change'), async () => {
  if ($('new-password').value !== $('repeat-password').value) throw new Error('两次输入不一致');
  await request('password', { oldPassword, password: $('new-password').value }); oldPassword = ''; location.assign('/');
}); });
$('logout').addEventListener('click', () => submit($('login'), async () => { await request('logout', {}); location.assign('/login.html'); }));
request('session').then(data => {
  if (!data.authenticated) return;
  $('logout').hidden = false; $('back').hidden = false;
  if (data.environmentPassword) $('hint').textContent = '已登录。密码由服务器部署环境设置。';
  else $('hint').textContent = '已登录。输入当前密码后可修改密码。';
}).catch(error => { $('error').textContent = error.message; });
