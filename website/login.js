(() => {
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const button = document.getElementById('login-submit');
  const params = new URLSearchParams(window.location.search);
  const showError = (message) => { errorBox.textContent = message; errorBox.hidden = false; };
  if (params.has('error')) {
    const messages = {
      oauth: 'Discord sign-in could not be completed. Please try again.',
      not_authorized: 'This Discord account is not authorised for the dashboard.',
      access_denied: 'Sign-in was cancelled.'
    };
    showError(messages[params.get('error')] || 'Sign-in failed. Please try again.');
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    button.disabled = true;
    button.firstChild.textContent = 'Checking account… ';
    try {
      const response = await fetch('/auth/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'The dashboard login service is unavailable.');
      if (result.next !== '/auth/discord') throw new Error('Unexpected sign-in response. Please contact the dashboard owner.');
      window.location.assign(result.next);
    } catch (error) {
      showError(error.message === 'Failed to fetch'
        ? 'The secure login server is not connected at this website address yet. Your password was not sent to or stored by this preview.'
        : error.message || 'Could not sign in. Please try again.');
      button.disabled = false;
      button.firstChild.textContent = 'Continue securely ';
    }
  });
})();
