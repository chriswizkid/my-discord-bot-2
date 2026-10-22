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
  updateTicket();
  updateEmbed();
})();