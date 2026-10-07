const $ = id => document.getElementById(id);
const form = $('login-form');
const codeForm = $('code-form');
if (new URL(location.href).searchParams.get('error') === 'corp') $('login-message').textContent = 'Этот аккаунт Corp не подключён. Используйте логин и пароль сервиса.';

let emailAvailable = false;
function show(way) {
  const byCode = way === 'code' && emailAvailable;
  codeForm.hidden = !byCode; form.hidden = byCode;
  $('switch-password').hidden = !byCode; $('switch-code').hidden = byCode || !emailAvailable;
  (byCode ? codeForm.elements.email : form.elements.username).focus();
}
void fetch('/api/auth/options').then(response => response.json()).then(options => {
  $('corp-login').hidden = !options.corpAvailable;
  emailAvailable = Boolean(options.emailAvailable);
  show(emailAvailable ? 'code' : 'password');
}).catch(() => {});
$('switch-password').onclick = () => show('password');
$('switch-code').onclick = () => show('code');

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json()).error);
}

// Step one asks for the address and sends a code; step two takes the code from the letter.
let codeSent = false;
function codeStep(sent) {
  codeSent = sent;
  $('code-label').hidden = !sent; $('code-restart').hidden = !sent;
  codeForm.elements.email.readOnly = sent;
  codeForm.elements.code.required = sent;
  $('code-submit').textContent = sent ? 'Войти' : 'Получить код';
  if (sent) codeForm.elements.code.focus();
}
codeForm.onsubmit = async event => {
  event.preventDefault();
  const button = $('code-submit'); button.disabled = true;
  try {
    const email = codeForm.elements.email.value.trim();
    if (!codeSent) {
      await post('/api/auth/code', { email });
      $('code-message').textContent = `Письмо с кодом отправлено на ${email}. Код действует 10 минут.`;
      codeStep(true);
    } else {
      await post('/api/auth/code/verify', { email, code: codeForm.elements.code.value });
      location.href = '/app/';
    }
  } catch (error) { $('code-message').textContent = error.message; }
  finally { button.disabled = false; }
};
$('code-restart').onclick = () => { codeForm.elements.code.value = ''; $('code-message').textContent = ''; codeStep(false); };

form.onsubmit = async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await post('/api/auth/login', { username: form.elements.username.value, password: form.elements.password.value });
    location.href = '/app/';
  } catch (error) { $('login-message').textContent = error.message; }
  finally { form.elements.password.value = ''; button.disabled = false; }
};
