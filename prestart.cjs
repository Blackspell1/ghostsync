const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const fallbackDbUrl = Buffer.from(
  'cG9zdGdyZXNxbDovL25lb25kYl9vd25lcjpucGdfS2Y0dHVhaDBUa1dsQGVwLWNvbGQtZmVhdGhlci1iMWF1bHdxZC5jLTUuZXUtY2VudHJhbC0xLmF3cy5uZW9uLnRlY2gvbmVvbmRiP3NzbG1vZGU9cmVxdWlyZQ==',
  'base64'
).toString('utf-8');

let dbUrl = process.env.DATABASE_URL;

if (fs.existsSync('/etc/secrets/.env')) {
  try {
    const secretContent = fs.readFileSync('/etc/secrets/.env', 'utf8');
    const match = secretContent.match(/DATABASE_URL=["']?([^"'\r\n]+)["']?/);
    if (match && match[1]) {
      dbUrl = match[1].trim();
    }
  } catch (e) {
    console.error('Error reading /etc/secrets/.env:', e);
  }
}

if (!dbUrl || dbUrl.trim() === '') {
  dbUrl = fallbackDbUrl;
}

process.env.DATABASE_URL = dbUrl;

// Clean up prisma/.env if present to prevent Prisma conflict error
const prismaEnv = path.join('prisma', '.env');
if (fs.existsSync(prismaEnv)) {
  try {
    fs.unlinkSync(prismaEnv);
  } catch (e) {}
}

// Write to .env
const envLine = `DATABASE_URL="${dbUrl}"\n`;

try {
  let existingEnv = '';
  if (fs.existsSync('.env')) {
    existingEnv = fs.readFileSync('.env', 'utf8');
  }
  // Replace or append DATABASE_URL
  if (existingEnv.includes('DATABASE_URL=')) {
    existingEnv = existingEnv.replace(/DATABASE_URL=.*(\r?\n|$)/g, envLine);
    fs.writeFileSync('.env', existingEnv, 'utf8');
  } else {
    fs.writeFileSync('.env', (existingEnv ? existingEnv + '\n' : '') + envLine, 'utf8');
  }
  console.log('Ensured DATABASE_URL is configured in .env');
} catch (e) {
  console.error('Error writing .env file:', e);
}

// If invoked with an action argument like 'setup' or 'start'
const action = process.argv[2];
const env = { ...process.env, DATABASE_URL: dbUrl };

if (action === 'setup') {
  console.log('Running prisma generate and db push with active DATABASE_URL...');
  execSync('npx prisma generate', { stdio: 'inherit', env });
  execSync('npx prisma db push --skip-generate', { stdio: 'inherit', env });
} else if (action === 'start') {
  console.log('Starting application server...');
  execSync('npx react-router-serve ./build/server/index.js', { stdio: 'inherit', env });
}
