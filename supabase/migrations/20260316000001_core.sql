-- Migration 001: Core tables (workspaces, organizations, users, portal settings)

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  slug text NOT NULL,
  pirate_ship_name text,
  billing_email text,
  onboarding_state jsonb DEFAULT '{}',
  storage_fee_waived boolean DEFAULT false,
  warehouse_grace_period_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, slug)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE NOT NULL,
  email text NOT NULL,
  name text,
  role text NOT NULL CHECK (role IN ('admin', 'super_admin', 'label_staff', 'label_management', 'warehouse_manager', 'client', 'client_admin')),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_auth_user_id ON users(auth_user_id);
CREATE INDEX idx_users_workspace_id ON users(workspace_id);

CREATE TABLE portal_admin_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  settings jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, org_id)
);
