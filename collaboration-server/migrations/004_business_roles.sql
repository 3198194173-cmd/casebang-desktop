ALTER TABLE app_users
  ADD COLUMN business_role text
  CHECK(business_role IN ('upstream','downstream'));

ALTER TABLE auth_attempts
  ADD COLUMN requested_business_role text
  CHECK(requested_business_role IN ('upstream','downstream'));

CREATE INDEX app_users_business_role
  ON app_users(organization_id,business_role,active);
