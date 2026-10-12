-- Runtime-role tenant binding (schema v10). Row-level security from migrations 001/003 compares tenant_id with the
-- transaction setting app.tenant_id, which any role can set to any value: a role holding the runtime credentials
-- could rebind to another tenant's UUID and act on its rows. This migration adds a second, restrictive check that
-- the database enforces independently of that setting:
--   * tenant_runtime_bindings records which database role may act on which tenant (maintained by the owner only);
--   * a RESTRICTIVE policy on every tenant table admits a row only for the table owner or a role bound to its tenant.
-- Restrictive policies are AND-ed with the existing permissive isolation policies, so access can only narrow.
-- A role without any binding sees and writes nothing (fail closed). Start-up additionally requires the runtime role to
-- be bound to exactly the configured tenant. Existing installations, after this migration: (1) GRANT SELECT (only) on
-- tenant_runtime_bindings to the runtime role, (2) bind it with the audited operator path, (3) start (fail closed).
CREATE TABLE public.tenant_runtime_bindings (
  role_name name NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants (tenant_id) ON DELETE CASCADE,
  PRIMARY KEY (role_name, tenant_id)
);

-- Not FORCE: the owner maintains bindings; every other role sees only its own bindings.
ALTER TABLE public.tenant_runtime_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_runtime_bindings_self ON public.tenant_runtime_bindings
  USING (role_name = current_user);

REVOKE ALL ON public.tenant_runtime_bindings FROM PUBLIC;

-- SECURITY INVOKER: evaluated with the caller's rights, so the binding lookup is itself subject to the policy above.
-- The table owner (and members of the owning role) keep the access they have today for migrations and operator paths.
CREATE FUNCTION public.tenant_runtime_allowed(p_tenant_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
    OR EXISTS (SELECT 1 FROM public.tenant_runtime_bindings b
               WHERE b.role_name = current_user AND b.tenant_id = p_tenant_id)
  FROM pg_catalog.pg_class c
 WHERE c.oid = 'public.tenant_runtime_bindings'::pg_catalog.regclass
$$;

CREATE POLICY tenant_runtime_binding_tenants ON public.tenants AS RESTRICTIVE
  USING (public.tenant_runtime_allowed(tenant_id)) WITH CHECK (public.tenant_runtime_allowed(tenant_id));
CREATE POLICY tenant_runtime_binding_webhook_events ON public.webhook_events AS RESTRICTIVE
  USING (public.tenant_runtime_allowed(tenant_id)) WITH CHECK (public.tenant_runtime_allowed(tenant_id));
CREATE POLICY tenant_runtime_binding_audit_events ON public.audit_events AS RESTRICTIVE
  USING (public.tenant_runtime_allowed(tenant_id)) WITH CHECK (public.tenant_runtime_allowed(tenant_id));
CREATE POLICY tenant_runtime_binding_audit_retention_anchors ON public.audit_retention_anchors AS RESTRICTIVE
  USING (public.tenant_runtime_allowed(tenant_id)) WITH CHECK (public.tenant_runtime_allowed(tenant_id));
