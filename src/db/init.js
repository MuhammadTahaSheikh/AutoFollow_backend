import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

async function runAlter(connection, sql) {
  try {
    await connection.query(sql);
  } catch (err) {
    const ignorable =
      err.code === 'ER_DUP_FIELDNAME' ||
      err.code === 'ER_DUP_KEYNAME' ||
      err.code === 'ER_TABLE_EXISTS_ERROR' ||
      err.code === 'ER_CANT_CREATE_TABLE' ||
      err.code === 'ER_FK_DUP_NAME' ||
      err.errno === 121;
    if (!ignorable) throw err;
  }
}

async function migrateExistingUsers(connection) {
  const [usersWithoutOrg] = await connection.query(
    'SELECT id, name, company_name FROM users WHERE organization_id IS NULL'
  );

  for (const user of usersWithoutOrg) {
    const orgName = (user.company_name || `${user.name}'s Organization`).slice(0, 255);
    const [orgResult] = await connection.query(
      'INSERT INTO organizations (name) VALUES (?)',
      [orgName]
    );

    await connection.query(
      `UPDATE users SET organization_id = ?, role = 'super_admin' WHERE id = ?`,
      [orgResult.insertId, user.id]
    );

    await connection.query(
      'UPDATE leads SET organization_id = ? WHERE user_id = ? AND organization_id IS NULL',
      [orgResult.insertId, user.id]
    );
  }

  const [usersMissingRole] = await connection.query(
    "SELECT id FROM users WHERE role IS NULL OR role = ''"
  );

  for (const user of usersMissingRole) {
    await connection.query(
      `UPDATE users SET role = 'super_admin' WHERE id = ?`,
      [user.id]
    );
  }
}

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
    CREATE TABLE IF NOT EXISTS organizations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('super_admin', 'admin', 'user') DEFAULT 'user',
      organization_id INT,
      company_name VARCHAR(255),
      job_title VARCHAR(255),
      phone VARCHAR(50),
      calendar_url VARCHAR(500),
      services_description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
    )
  `);

  for (const sql of [
    'ALTER TABLE users ADD COLUMN company_name VARCHAR(255)',
    'ALTER TABLE users ADD COLUMN job_title VARCHAR(255)',
    'ALTER TABLE users ADD COLUMN phone VARCHAR(50)',
    'ALTER TABLE users ADD COLUMN calendar_url VARCHAR(500)',
    'ALTER TABLE users ADD COLUMN services_description TEXT',
    "ALTER TABLE users ADD COLUMN role ENUM('super_admin', 'admin', 'user') DEFAULT 'user'",
    'ALTER TABLE users ADD COLUMN organization_id INT',
  ]) {
    await runAlter(connection, sql);
  }

  await runAlter(
    connection,
    'ALTER TABLE users ADD CONSTRAINT fk_users_organization FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL'
  );

  await connection.query(`
    CREATE TABLE IF NOT EXISTS invitations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      organization_id INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
      token VARCHAR(64) NOT NULL UNIQUE,
      invited_by INT NOT NULL,
      status ENUM('pending', 'accepted', 'expired', 'cancelled') DEFAULT 'pending',
      expires_at DATETIME NOT NULL,
      accepted_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_invite_token (token),
      INDEX idx_invite_org_status (organization_id, status)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      organization_id INT,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      source VARCHAR(100) DEFAULT 'manual',
      status ENUM('new', 'contacted', 'qualified', 'converted', 'lost') DEFAULT 'new',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      INDEX idx_user_status (user_id, status),
      INDEX idx_org_status (organization_id, status)
    )
  `);

  await runAlter(connection, 'ALTER TABLE leads ADD COLUMN organization_id INT');
  await runAlter(
    connection,
    'ALTER TABLE leads ADD CONSTRAINT fk_leads_organization FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE'
  );
  await runAlter(connection, 'ALTER TABLE leads ADD INDEX idx_org_status (organization_id, status)');

  await connection.query(`
    CREATE TABLE IF NOT EXISTS lead_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      lead_id INT NOT NULL,
      user_id INT NOT NULL,
      assigned_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uniq_lead_user (lead_id, user_id),
      INDEX idx_user_leads (user_id, lead_id)
    )
  `);

  const [leadsWithoutAssignment] = await connection.query(
    `SELECT l.id, l.user_id FROM leads l
     LEFT JOIN lead_assignments la ON la.lead_id = l.id
     WHERE la.id IS NULL`
  );

  for (const lead of leadsWithoutAssignment) {
    await connection.query(
      `INSERT IGNORE INTO lead_assignments (lead_id, user_id, assigned_by)
       SELECT ?, u.id, ?
       FROM users u
       WHERE u.id = ? AND u.role = 'user'`,
      [lead.id, lead.user_id, lead.user_id]
    );
  }

  await connection.query(
    `DELETE la FROM lead_assignments la
     INNER JOIN users u ON u.id = la.user_id
     WHERE u.role != 'user'`
  );

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

  await migrateExistingUsers(connection);

  console.log(`Database "${dbName}" initialized successfully.`);
  await connection.end();
}

initDatabase().catch((err) => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
