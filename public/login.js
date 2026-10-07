const form = document.getElementById('login-form');
document.getElementById('corp-login').href = 'https://auth.example.org/login?return_to=' + encodeURIComponent(location.origin + '/app/');
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
