import { h, clear } from './dom.mjs';
import { api } from './net.mjs';
import { isCloudRuntime } from './runtime.mjs';

export async function requireSession() {
  if (!isCloudRuntime()) return { local: true };
  try {
    return await api.session();
  } catch (err) {
    renderLogin(err.status === 401 ? null : err.message);
    return null;
  }
}

export async function signOut() {
  try { await api.logout(); } finally { location.reload(); }
}

function renderLogin(initialError) {
  document.body.classList.add('auth-mode');
  const rail = document.getElementById('rail');
  const main = document.getElementById('view');
  const loginEmail = h('input.input', {
    id: 'login-email', type: 'email', autocomplete: 'username', required: true,
    inputmode: 'email', spellcheck: false,
  });
  const loginPassword = h('input.input', {
    id: 'login-password', type: 'password', autocomplete: 'current-password', required: true,
  });
  const loginError = h('p.field-error', { text: initialError ?? '', hidden: !initialError, role: 'alert' });
  const loginSubmit = h('button.btn.btn-primary', { type: 'submit', text: '登入' });
  const showRegister = h('button.auth-switch', { type: 'button', text: '第一次使用？建立唯一帳號' });
  const loginForm = h('form.auth-card.card', {},
    h('p.eyebrow', { text: 'PRIVATE STUDY SPACE' }),
    h('h1', { text: '回到你的法文進度' }),
    h('p.auth-lead', { text: '題庫、複習紀錄與四科練習只對你的帳號開放。' }),
    h('label', { for: 'login-email', text: '電子郵件' }), loginEmail,
    h('label', { for: 'login-password', text: '密碼' }), loginPassword,
    loginError,
    loginSubmit,
    showRegister,
  );
  loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    loginSubmit.disabled = true;
    loginSubmit.textContent = '登入中…';
    loginError.hidden = true;
    try {
      await api.login({ email: loginEmail.value, password: loginPassword.value });
      location.reload();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.hidden = false;
      loginPassword.select();
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登入';
    }
  });

  const registerEmail = h('input.input', {
    id: 'register-email', type: 'email', autocomplete: 'username', required: true,
    inputmode: 'email', spellcheck: false,
  });
  const registerPassword = h('input.input', {
    id: 'register-password', type: 'password', autocomplete: 'new-password', minlength: 12, required: true,
  });
  const registerConfirm = h('input.input', {
    id: 'register-confirm', type: 'password', autocomplete: 'new-password', minlength: 12, required: true,
  });
  const registerError = h('p.field-error', { hidden: true, role: 'alert' });
  const registerSuccess = h('p.field-success', { hidden: true, role: 'status' });
  const registerSubmit = h('button.btn.btn-primary', { type: 'submit', text: '建立帳號' });
  const showLogin = h('button.auth-switch', { type: 'button', text: '已有帳號，回到登入' });
  const registerForm = h('form.auth-card.card', { hidden: true },
    h('p.eyebrow', { text: 'OWNER SETUP' }),
    h('h1', { text: '建立唯一帳號' }),
    h('p.auth-lead', { text: '只有已核定的信箱能建立帳號。密碼直接送往 Supabase，不會寫進 cadence。' }),
    h('label', { for: 'register-email', text: '核定信箱' }), registerEmail,
    h('label', { for: 'register-password', text: '密碼' }), registerPassword,
    h('p.field-note', { text: '至少 12 個字元；請使用未在其他網站使用過的密碼。' }),
    h('label', { for: 'register-confirm', text: '再次輸入密碼' }), registerConfirm,
    registerError,
    registerSuccess,
    registerSubmit,
    showLogin,
  );
  registerForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    registerError.hidden = true;
    registerSuccess.hidden = true;
    if (registerPassword.value !== registerConfirm.value) {
      registerError.textContent = '兩次輸入的密碼不同';
      registerError.hidden = false;
      registerConfirm.select();
      return;
    }
    registerSubmit.disabled = true;
    registerSubmit.textContent = '建立中…';
    try {
      const result = await api.register({ email: registerEmail.value, password: registerPassword.value });
      registerPassword.value = '';
      registerConfirm.value = '';
      if (!result.needsConfirmation) {
        location.reload();
        return;
      }
      registerSuccess.textContent = '驗證信已寄出。請完成信箱驗證，再回到這裡登入。';
      registerSuccess.hidden = false;
    } catch (err) {
      registerError.textContent = err.message;
      registerError.hidden = false;
    } finally {
      registerSubmit.disabled = false;
      registerSubmit.textContent = '建立帳號';
    }
  });

  const switchTo = (target) => {
    const registering = target === 'register';
    loginForm.hidden = registering;
    registerForm.hidden = !registering;
    if (registering) {
      registerEmail.value = loginEmail.value;
      registerEmail.focus();
    } else {
      loginEmail.value = registerEmail.value;
      loginEmail.focus();
    }
  };
  showRegister.addEventListener('click', () => switchTo('register'));
  showLogin.addEventListener('click', () => switchTo('login'));

  clear(rail);
  rail.append(h('a.brand', { href: '/', onclick: (ev) => ev.preventDefault() },
    h('b', { text: 'cadence' }), h('span', { text: '法文複習' })));
  clear(main);
  main.append(h('section.auth-wrap', {}, loginForm, registerForm));
  document.title = '登入 · cadence';
  loginEmail.focus();
}
