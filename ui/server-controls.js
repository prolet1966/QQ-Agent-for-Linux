fetch('/api/auth/session').then(r => r.json()).then(data => {
  if (!data.authenticated) return;
  const link = document.createElement('a');
  link.href = '/login.html?change'; link.textContent = '密码 / 退出'; link.className = 'nav-btn';
  document.getElementById('tabs')?.append(link);
}).catch(() => {});
