import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
  console.log('Host:    ', process.env.DB_HOST);
  console.log('User:    ', process.env.DB_USER);
  console.log('Database:', process.env.DB_NAME);
  console.log('Password length:', process.env.DB_PASSWORD?.length ?? 0);

  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectTimeout: 10000,
    });

    const [tables] = await conn.query('SHOW TABLES');
    console.log('\n✅ Connected successfully!');
    console.log('Tables:', tables.map((r) => Object.values(r)[0]).join(', ') || '(none — run schema.sql in phpMyAdmin)');
    await conn.end();
  } catch (err) {
    console.log('\n❌ Connection failed:', err.message);
    console.log('\nFix checklist:');
    console.log('1. hPanel → Databases → Management → ⋮ → Change password');
    console.log('2. Copy that password into backend/.env → DB_PASSWORD');
    console.log('3. Remote MySQL → delete old rule → re-add IP 139.135.35.49 (or Any Host)');
    console.log('4. Run: npm run db:test');
    process.exit(1);
  }
}

test();
