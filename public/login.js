const form = document.getElementById('login-form');
if (new URL(location.href).searchParams.get('error') === 'corp') document.getElementById('login-message').textContent = 'Этот аккаунт Corp не подключён. Используйте логин и пароль сервиса.';
void fetch('/api/auth/options').then(response => response.json()).then(options => { document.getElementById('corp-login').hidden = !options.corpAvailable; }).catch(() => {});
form.onsubmit = async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) });
    form.elements.password.value = '';
    if (!response.ok) throw new Error((await response.json()).error);
    location.href = '/app/';
  } catch (error) { document.getElementById('login-message').textContent = error.message; }
  finally { button.disabled = false; }
};
