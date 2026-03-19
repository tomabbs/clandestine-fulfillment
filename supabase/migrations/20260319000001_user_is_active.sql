-- Add is_active column to users for deactivation support
ALTER TABLE users ADD COLUMN is_active boolean NOT NULL DEFAULT true;
