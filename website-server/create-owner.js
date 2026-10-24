require('dotenv').config();
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const readline = require('node:readline');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    let value = '';
    stdin.resume();
    stdin.setRawMode(true);
    const onData = (chunk) => {
      const key = chunk.toString('utf8');
      if (key === '\\u0003') { cleanup(); process.exit(1); }
      if (key === '\\r' || key === '\\n') {
        stdout.write('\n');
        cleanup();
        resolve(value);
      } else if (key === '\\u007f' || key === '\\b') {
        value = value.slice(0, -1);
      } else if (key >= ' ' && key !== '\\u001b') {
        value += key;
      }
    };
    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    }
    stdin.on('data', onData);
  });
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DATABASE || '3c_dashboard';
  const ownerDiscordId = process.env.DASHBOARD_OWNER_DISCORD_ID;
  if (!uri || !ownerDiscordId) throw new Error('Set MONGODB_URI and DASHBOARD_OWNER_DISCORD_ID in .env first.');
  if (!/^\\d{15,22}$/.test(ownerDiscordId)) throw new Error('DASHBOARD_OWNER_DISCORD_ID must be your numeric Discord user ID.');
  console.log('This creates the initial dashboard login in database:', dbName);
  console.log('Use your TEST database only. This does not touch the bot_state collection.');
  const confirm = await ask('Type CREATE TEST OWNER to continue: ');
  if (confirm !== 'CREATE TEST OWNER') throw new Error('Cancelled.');
  const username = (await ask('Choose a dashboard username: ')).toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 characters: letters, numbers, dots, underscores, or hyphens.');
  const password = await askHidden('Choose a password (12+ characters; input hidden): ');
  if (password.length < 12 || password.length > 200) throw new Error('Password must be 12–200 characters.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    const users = db.collection('dashboardUsers');
    const existingOwner = await users.findOne({ discordId: ownerDiscordId });
    if (existingOwner) throw new Error('An account for the configured owner Discord ID already exists. No changes made.');
    const existingName = await users.findOne({ username });
    if (existingName) throw new Error('That username already exists. No changes made.');
    const passwordHash = await bcrypt.hash(password, 12);
    await users.insertOne({
      username,
      passwordHash,
      discordId: ownerDiscordId,
      permissions: ['*'],
      serverIds: ['*'],
      status: 'active',
      createdAt: new Date(),
      createdBy: 'initial-owner-setup'
    });
    console.log('Initial dashboard login created. Sign in with this username/password, then complete Discord OAuth as the configured owner account.');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('Owner setup failed:', error.message);
  process.exitCode = 1;
});
