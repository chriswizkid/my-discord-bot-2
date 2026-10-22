(() => {
  const errorBox = document.getElementById('error');
  const params = new URLSearchParams(window.location.search);
  const errors = {
    oauth: 'Discord sign-in did not finish. Please try again.',
    not_authorized: 'This Discord account is not linked to an active 3C dashboard account.',
    access_denied: 'Sign-in was cancelled. You can try again whenever you are ready.'
  };
  if (errors[params.get('error')]) {
    errorBox.textContent = errors[params.get('error')];
    errorBox.hidden = false;
  }
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Checking account…';
    try {
      const response = await fetch('/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: document.getElementById('password').value
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
      window.location.href = result.next || '/auth/discord';
    } catch (error) {
      errorBox.textContent = error.message || 'Unable to sign in. Try again.';
      errorBox.hidden = false;
      button.innerHTML = 'Continue with Discord <span>↗</span>';
      button.disabled = false;
    }
  });
})();