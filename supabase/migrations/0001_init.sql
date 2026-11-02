-- ============================================================================
-- 1. ENUMS
-- ============================================================================
CREATE TYPE app_role AS ENUM ('ADMIN', 'VENDOR', 'CUSTOMER');
CREATE TYPE doc_format AS ENUM ('PDF', 'DOCX', 'PNG', 'JPEG');
CREATE TYPE job_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE commission_mode AS ENUM ('PERCENTAGE', 'FLAT');
CREATE TYPE ledger_entry_type AS ENUM ('COMMISSION_EARNED', 'PAYOUT_WITHDRAWAL', 'COMMISSION_REVERSED');
CREATE TYPE payout_status AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED');

-- ============================================================================
-- 2. PUBLIC PROFILES (Extends auth.users)
-- ============================================================================
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT,
    role app_role NOT NULL DEFAULT 'CUSTOMER',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vendor Specific Data
CREATE TABLE public.vendor_profiles (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    business_name TEXT NOT NULL,
    commission_type commission_mode NOT NULL DEFAULT 'PERCENTAGE',
    commission_rate NUMERIC(8, 2) NOT NULL DEFAULT 20.00,
    wallet_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (wallet_balance >= 0.00),
    payout_info JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 3. PRICING RULES & TEMPLATES
-- ============================================================================
CREATE TABLE public.pricing_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    format doc_format NOT NULL,
    base_price NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_format_currency UNIQUE (format, currency)
);

INSERT INTO public.pricing_rules (format, base_price, currency) VALUES
('PDF', 10.00, 'INR'),
('PNG', 15.00, 'INR'),
('JPEG', 15.00, 'INR'),
('DOCX', 35.00, 'INR');

CREATE TABLE public.templates (
    id VARCHAR(100) PRIMARY KEY,
    name TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    schema_definition JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 4. DOCUMENT JOBS & FINANCIAL AUDITING
-- ============================================================================
CREATE TABLE public.document_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.profiles(id),
    vendor_id UUID REFERENCES public.profiles(id), -- NULL if customer generated directly
    template_id VARCHAR(100) NOT NULL REFERENCES public.templates(id),
    requested_format doc_format NOT NULL,
    payload JSONB NOT NULL,
    total_charged NUMERIC(10, 2) NOT NULL,
    vendor_cut NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    status job_status NOT NULL DEFAULT 'PENDING',
    storage_path TEXT,                           -- Supabase Storage bucket path
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_document_jobs_customer ON public.document_jobs(customer_id);
CREATE INDEX idx_document_jobs_vendor ON public.document_jobs(vendor_id);
CREATE INDEX idx_document_jobs_status ON public.document_jobs(status);

CREATE TABLE public.vendor_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES public.profiles(id),
    job_id UUID REFERENCES public.document_jobs(id),
    entry_type ledger_entry_type NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    balance_after NUMERIC(12, 2) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.vendor_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES public.profiles(id),
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    status payout_status NOT NULL DEFAULT 'REQUESTED',
    admin_notes TEXT,
    processed_by UUID REFERENCES public.profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- ============================================================================
-- 5. AUTOMATIC PROFILE CREATION TRIGGER
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    assigned_role public.app_role;
    b_name TEXT;
BEGIN
    assigned_role := COALESCE(
        (NEW.raw_user_meta_data->>'role')::public.app_role,
        'CUSTOMER'::public.app_role
    );
    b_name := COALESCE(NEW.raw_user_meta_data->>'business_name', 'My Agency');

    INSERT INTO public.profiles (id, email, full_name, role)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data->>'full_name',
        assigned_role
    );

    IF assigned_role = 'VENDOR' THEN
        INSERT INTO public.vendor_profiles (user_id, business_name)
        VALUES (NEW.id, b_name);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 6. AUTH HOOK: INJECT ROLE INTO SUPABASE JWT (Custom Claims)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB AS $$
DECLARE
    claims JSONB;
    user_role public.app_role;
BEGIN
    SELECT role INTO user_role FROM public.profiles WHERE id = (event->>'user_id')::UUID;

    claims := event->'claims';
    IF user_role IS NOT NULL THEN
        claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));
    ELSE
        claims := jsonb_set(claims, '{user_role}', '"CUSTOMER"'::jsonb);
    END IF;

    event := jsonb_set(event, '{claims}', claims);
    RETURN event;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
-- The hook SELECTs from profiles at token-mint time; the auth service runs as
-- supabase_auth_admin, which has no table privileges by default.
GRANT SELECT ON TABLE public.profiles TO supabase_auth_admin;

-- ============================================================================
-- 7. ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_payouts ENABLE ROW LEVEL SECURITY;

-- Helper Functions to read JWT claim
CREATE OR REPLACE FUNCTION public.jwt_role() RETURNS TEXT AS $$
    SELECT COALESCE(auth.jwt() ->> 'user_role', 'CUSTOMER');
$$ LANGUAGE sql STABLE;

-- Profiles: Users view own profile; Admins view all
CREATE POLICY "Users read own profile" ON public.profiles
    FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.jwt_role() = 'ADMIN');

-- Pricing & Templates: Read-only for all logged-in users; Admins can edit
CREATE POLICY "Public read pricing" ON public.pricing_rules
    FOR SELECT TO authenticated USING (is_active = TRUE);

CREATE POLICY "Public read templates" ON public.templates
    FOR SELECT TO authenticated USING (is_active = TRUE);

-- Document Jobs Access:
-- Customers see docs they own
-- Vendors see docs they generated
-- Admins see everything
CREATE POLICY "Read document jobs" ON public.document_jobs
    FOR SELECT TO authenticated
    USING (
        customer_id = auth.uid()
        OR vendor_id = auth.uid()
        OR public.jwt_role() = 'ADMIN'
    );

-- Vendor Profiles & Ledger: Vendors see their own balances; Admins see all
CREATE POLICY "Vendors view own balance" ON public.vendor_profiles
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.jwt_role() = 'ADMIN');

CREATE POLICY "Vendors view own ledger" ON public.vendor_ledger
    FOR SELECT TO authenticated
    USING (vendor_id = auth.uid() OR public.jwt_role() = 'ADMIN');

CREATE POLICY "Vendors view own payouts" ON public.vendor_payouts
    FOR SELECT TO authenticated
    USING (vendor_id = auth.uid() OR public.jwt_role() = 'ADMIN');
