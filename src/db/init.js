import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

async function initDatabase() {
  const dbName = process.env.DB_NAME || 'autofollow_crm';
  const skipCreate = process.env.DB_SKIP_CREATE === 'true';

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ...(skipCreate ? { database: dbName } : {}),
  });

  if (!skipCreate) {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.query(`USE \`${dbName}\``);
  }

  await connection.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      company_name VARCHAR(255),
      job_title VARCHAR(255),
      phone VARCHAR(50),
      calendar_url VARCHAR(500),
      services_description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  for (const sql of [
    'ALTER TABLE users ADD COLUMN company_name VARCHAR(255)',
    'ALTER TABLE users ADD COLUMN job_title VARCHAR(255)',
    'ALTER TABLE users ADD COLUMN phone VARCHAR(50)',
    'ALTER TABLE users ADD COLUMN calendar_url VARCHAR(500)',
    'ALTER TABLE users ADD COLUMN services_description TEXT',
  ]) {
    try {
      await connection.query(sql);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  await connection.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      source VARCHAR(100) DEFAULT 'manual',
      status ENUM('new', 'contacted', 'qualified', 'converted', 'lost') DEFAULT 'new',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_status (user_id, status)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS email_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      lead_id INT NOT NULL,
      subject VARCHAR(500) NOT NULL,
      body TEXT NOT NULL,
      scheduled_at DATETIME NOT NULL,
      status ENUM('pending', 'sent', 'failed', 'cancelled') DEFAULT 'pending',
      sent_at DATETIME,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
      INDEX idx_pending (status, scheduled_at)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS ai_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      lead_id INT,
      type ENUM('follow_up', 'sales', 're_engagement') NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
    )
  `);

  console.log(`Database "${dbName}" initialized successfully.`);
  await connection.end();
}

initDatabase().catch((err) => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
