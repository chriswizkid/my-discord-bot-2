(() => {
  const pageTitles = {
    overview: 'Overview', tickets: 'Tickets & panels', webhooks: 'Embed studio',
    applications: 'Staff applications', moderation: 'Moderation & logs',
    accounts: 'Accounts & permissions', commands: 'Commands & games'
  };
  function showPage(name) {
    if (!pageTitles[name]) return;
    document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-' + name));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === name));
    document.getElementById('page-title').textContent = pageTitles[name];
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.querySelectorAll('[data-page]').forEach(btn => btn.addEventListener('click', () => showPage(btn.dataset.page)));
  document.querySelectorAll('[data-go]').forEach(btn => btn.addEventListener('click', () => showPage(btn.dataset.go)));

  let ticketColor = 'blue';
  const ticketTitle = document.getElementById('ticket-title');
  const ticketDescription = document.getElementById('ticket-description');
  const ticketLabel = document.getElementById('ticket-label');
  const updateTicket = () => {
    document.getElementById('ticket-preview-title').textContent = ticketTitle.value || 'Ticket panel';
    document.getElementById('ticket-preview-description').textContent = ticketDescription.value || 'Add a description for your members.';
    const btn = document.getElementById('ticket-preview-button');
    btn.className = 'fake-button ' + ticketColor;
    btn.textContent = '🎫 ' + (ticketLabel.value || 'Open a ticket');
  };
  document.querySelectorAll('.color-choice').forEach(btn => btn.addEventListener('click', () => {
    ticketColor = btn.dataset.color;
    document.querySelectorAll('.color-choice').forEach(b => b.classList.toggle('selected', b === btn));
    updateTicket();
  }));
  ['ticket-title','ticket-description','ticket-label'].forEach(id => document.getElementById(id).addEventListener('input', updateTicket));
  document.getElementById('refresh-ticket').addEventListener('click', updateTicket);

  const embedTitle = document.getElementById('embed-title');
  const embedDescription = document.getElementById('embed-description');
  const embedColor = document.getElementById('embed-color');
  const embedColorPicker = document.getElementById('embed-color-picker');
  const embedFooter = document.getElementById('embed-footer');
  const updateEmbed = () => {
    document.getElementById('embed-preview-title').textContent = embedTitle.value || 'Announcement';
    document.getElementById('embed-preview-description').textContent = embedDescription.value || 'Add your message here.';
    document.getElementById('embed-preview-footer').textContent = embedFooter.value || '3C Bot';
    let color = /^#[0-9a-fA-F]{6}$/.test(embedColor.value) ? embedColor.value : '#5865F2';
    document.getElementById('embed-preview').style.borderLeftColor = color;
  };
  embedColorPicker.addEventListener('input', () => { embedColor.value = embedColorPicker.value.toUpperCase(); updateEmbed(); });
  embedColor.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(embedColor.value)) embedColorPicker.value = embedColor.value;
    updateEmbed();
  });
  [embedTitle, embedDescription, embedFooter].forEach(el => el.addEventListener('input', updateEmbed));
  document.getElementById('refresh-embed').addEventListener('click', updateEmbed);

  const logSearch = document.getElementById('log-search');
  logSearch.addEventListener('input', () => {
    const query = logSearch.value.toLowerCase();
    document.querySelectorAll('#log-rows tr').forEach(row => row.hidden = !row.textContent.toLowerCase().includes(query));
  });

  // Account administration is shown only after the secure backend confirms main-owner access.
  // Hiding a link is only a UI convenience; API routes must enforce authorization too.
  const accountNav = document.querySelector('[data-page="accounts"]');
  const accountPage = document.getElementById('page-accounts');
  const accountShortcuts = document.querySelectorAll('[data-go="accounts"]');
  const hideAccountTools = () => {
    if (accountNav) accountNav.hidden = true;
    if (accountPage) accountPage.hidden = true;
    accountShortcuts.forEach(el => { el.hidden = true; });
    if (accountPage?.classList.contains('active')) showPage('overview');
  };
  hideAccountTools();
  fetch('/api/me', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
    .then(response => response.ok ? response.json() : null)
    .then(data => {
      if (data?.user?.isMainOwner === true) {
        if (accountNav) accountNav.hidden = false;
        if (accountPage) accountPage.hidden = false;
        accountShortcuts.forEach(el => { el.hidden = false; });
      }
    })
    .catch(() => {});

  // Load the authenticated user's real Discord server list into the sidebar selector.
  const serverChip = document.querySelector('.server-chip');
  if (serverChip) {
    serverChip.setAttribute('role', 'group');
    serverChip.setAttribute('aria-label', 'Discord server selector');
    serverChip.innerHTML = '<span class="server-icon">3C</span><span class="server-picker-wrap"><label class="server-picker-label" for="server-picker">SELECT SERVER</label><select id="server-picker" aria-label="Select a Discord server"><option value="">Loading servers…</option></select><small id="server-picker-status">Loading your Discord server list</small></span>';
    const picker = document.getElementById('server-picker');
    const status = document.getElementById('server-picker-status');
    fetch('/api/me', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(response => {
        if (!response.ok) throw new Error('Could not load your account');
        return response.json();
      })
      .then(data => {
        const guilds = Array.isArray(data?.user?.ownedGuilds) ? data.user.ownedGuilds : [];
        picker.replaceChildren();
        if (!guilds.length) {
          picker.add(new Option('No owned servers found', ''));
          status.textContent = 'Discord only returned servers you own. Make sure you authorised the correct account.';
          return;
        }
        picker.add(new Option('Choose a server…', ''));
        guilds.sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(guild => {
          picker.add(new Option(guild.name, guild.id));
        });
        status.textContent = guilds.length + ' server' + (guilds.length === 1 ? '' : 's') + ' available to this Discord account';
        picker.addEventListener('change', () => {
          const chosen = guilds.find(guild => guild.id === picker.value);
          if (!chosen) return;
          serverChip.dataset.selectedGuildId = chosen.id;
          serverChip.dataset.selectedGuildName = chosen.name;
          status.textContent = 'Selected: ' + chosen.name + ' · server-specific tools are being connected';
          document.dispatchEvent(new CustomEvent('3c:server-selected', { detail: { id: chosen.id, name: chosen.name } }));
        });
      })
      .catch(() => {
        picker.replaceChildren(new Option('Unable to load servers', ''));
        status.textContent = 'Refresh the page or sign in again.';
      });
  }

  updateTicket();
  updateEmbed();
})();