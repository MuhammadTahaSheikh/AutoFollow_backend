-- AutoFollow AI CRM - Run this in Hostinger phpMyAdmin
-- Select database: u916710688_autofollow_ai, then click SQL tab and paste this.

CREATE TABLE IF NOT EXISTS organizations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  plan ENUM('free', 'pro', 'agency') DEFAULT 'free',
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50) DEFAULT 'active',
  current_period_end DATETIME,
  cancel_at_period_end TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org_stripe_customer (stripe_customer_id)
);

CREATE TABLE IF NOT EXISTS usage_counters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  period_start DATE NOT NULL,
  ai_requests INT DEFAULT 0,
  emails_sent INT DEFAULT 0,
  storage_bytes BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_org_period (organization_id, period_start)
);

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
);

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
);

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
  team_member_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  INDEX idx_user_status (user_id, status),
  INDEX idx_org_status (organization_id, status)
);

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
);

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
);

CREATE TABLE IF NOT EXISTS ai_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  lead_id INT,
  type ENUM('follow_up', 'sales', 're_engagement') NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  lead_id INT,
  user_id INT NOT NULL,
  activity_type VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  metadata_json JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_lead_created (lead_id, created_at),
  INDEX idx_org_created (organization_id, created_at)
);

CREATE TABLE IF NOT EXISTS lead_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  user_id INT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_lead_notes (lead_id, created_at)
);

CREATE TABLE IF NOT EXISTS follow_up_sequences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  INDEX idx_org_active (organization_id, is_active)
);

CREATE TABLE IF NOT EXISTS follow_up_steps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sequence_id INT NOT NULL,
  step_number INT NOT NULL,
  delay_hours INT NOT NULL,
  subject VARCHAR(500) NOT NULL,
  message_template TEXT NOT NULL,
  FOREIGN KEY (sequence_id) REFERENCES follow_up_sequences(id) ON DELETE CASCADE,
  INDEX idx_sequence_steps (sequence_id, step_number)
);

CREATE TABLE IF NOT EXISTS lead_follow_ups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  step_id INT NOT NULL,
  scheduled_at DATETIME NOT NULL,
  sent_at DATETIME,
  status ENUM('pending', 'sent', 'failed', 'cancelled') DEFAULT 'pending',
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (step_id) REFERENCES follow_up_steps(id) ON DELETE CASCADE,
  INDEX idx_lead_follow_ups (lead_id, scheduled_at)
);

CREATE TABLE IF NOT EXISTS email_replies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  lead_id INT NOT NULL,
  from_email VARCHAR(255) NOT NULL,
  from_name VARCHAR(255),
  subject VARCHAR(500) NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  message_id VARCHAR(255),
  in_reply_to VARCHAR(255),
  received_at DATETIME NOT NULL,
  source VARCHAR(50) DEFAULT 'n8n',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  INDEX idx_lead_replies (lead_id, received_at),
  UNIQUE KEY uniq_message_id (message_id)
);
