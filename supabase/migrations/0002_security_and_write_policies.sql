-- ============================================================================
-- 0002: Security fixes + frontend write policies with DB-level value guards
--
-- Design rule: the frontend writes *requests*; the DATABASE computes *money*.
-- total_charged, vendor_cut, wallet balances and ledger entries can never be
-- set by a client — triggers compute them from pricing_rules / vendor_profiles.
-- ============================================================================

-- Ledger needs a refund entry type (used when an admin rejects a payout)
ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'PAYOUT_REFUNDED';

-- ============================================================================
-- 1. FIX: close the ADMIN signup escalation hole.
-- Self-signup may only ever produce CUSTOMER or VENDOR. ADMIN is granted
-- manually: UPDATE public.profiles SET role = 'ADMIN' WHERE email = 'you@...';
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    assigned_role public.app_role;
    b_name TEXT;
BEGIN
    assigned_role := CASE
        WHEN NEW.raw_user_meta_data->>'role' = 'VENDOR' THEN 'VENDOR'::public.app_role
        ELSE 'CUSTOMER'::public.app_role
    END;
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

-- ============================================================================
-- 2. Payment placeholder (gateway comes later — see 0002 note).
-- Mock mode treats every job as PAID; when Razorpay/Stripe lands, the backend
-- will create jobs with 'PENDING' and flip to 'PAID' after verification.
-- ============================================================================
CREATE TYPE payment_status AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

ALTER TABLE public.document_jobs
    ADD COLUMN payment_status payment_status NOT NULL DEFAULT 'PAID';

-- ============================================================================
-- 3. BEFORE INSERT on document_jobs: compute the money columns.
-- Client-supplied total_charged / vendor_cut are silently overwritten.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_job_pricing()
RETURNS TRIGGER AS $$
DECLARE
    base NUMERIC(10, 2);
    vp RECORD;
BEGIN
    SELECT base_price INTO base
    FROM public.pricing_rules
    WHERE format = NEW.requested_format AND currency = 'INR' AND is_active = TRUE;

    IF base IS NULL THEN
        RAISE EXCEPTION 'No active pricing rule for format %', NEW.requested_format;
    END IF;
    NEW.total_charged := base;
    NEW.vendor_cut := 0.00;

    IF NEW.vendor_id IS NOT NULL THEN
        SELECT commission_type, commission_rate INTO vp
        FROM public.vendor_profiles
        WHERE user_id = NEW.vendor_id;

        IF FOUND THEN
            IF vp.commission_type = 'PERCENTAGE' THEN
                NEW.vendor_cut := ROUND(base * vp.commission_rate / 100, 2);
            ELSE -- FLAT: commission_rate acts as a fixed amount per job
                NEW.vendor_cut := LEAST(vp.commission_rate, base);
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_compute_job_pricing
    BEFORE INSERT ON public.document_jobs
    FOR EACH ROW EXECUTE FUNCTION public.compute_job_pricing();

-- ============================================================================
-- 4. BEFORE UPDATE on document_jobs: commission credit / reversal + completed_at
-- The Node backend (service key) flips status after the Rust service finishes;
-- this trigger keeps wallet + ledger correct no matter who updates the row.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.on_job_status_change()
RETURNS TRIGGER AS $$
DECLARE
    new_balance NUMERIC(12, 2);
BEGIN
    IF NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED'
       AND NEW.vendor_id IS NOT NULL AND NEW.vendor_cut > 0 THEN
        UPDATE public.vendor_profiles
        SET wallet_balance = wallet_balance + NEW.vendor_cut, updated_at = NOW()
        WHERE user_id = NEW.vendor_id
        RETURNING wallet_balance INTO new_balance;

        INSERT INTO public.vendor_ledger (vendor_id, job_id, entry_type, amount, balance_after, description)
        VALUES (NEW.vendor_id, NEW.id, 'COMMISSION_EARNED', NEW.vendor_cut, new_balance,
                'Commission for job ' || NEW.id);

    ELSIF OLD.status = 'COMPLETED' AND NEW.status = 'FAILED'
          AND OLD.vendor_id IS NOT NULL AND OLD.vendor_cut > 0 THEN
        UPDATE public.vendor_profiles
        SET wallet_balance = wallet_balance - OLD.vendor_cut, updated_at = NOW()
        WHERE user_id = OLD.vendor_id
        RETURNING wallet_balance INTO new_balance;

        INSERT INTO public.vendor_ledger (vendor_id, job_id, entry_type, amount, balance_after, description)
        VALUES (OLD.vendor_id, OLD.id, 'COMMISSION_REVERSED', -OLD.vendor_cut, new_balance,
                'Commission reversed for job ' || OLD.id);
    END IF;

    IF NEW.status = 'COMPLETED' AND NEW.completed_at IS NULL THEN
        NEW.completed_at := NOW();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_on_job_status_change
    BEFORE UPDATE ON public.document_jobs
    FOR EACH ROW EXECUTE FUNCTION public.on_job_status_change();

-- ============================================================================
-- 5. Payout guards: balance check + atomic fund hold on request,
-- automatic refund when an admin rejects.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.hold_payout_funds()
RETURNS TRIGGER AS $$
DECLARE
    current_balance NUMERIC(12, 2);
BEGIN
    SELECT wallet_balance INTO current_balance
    FROM public.vendor_profiles
    WHERE user_id = NEW.vendor_id
    FOR UPDATE; -- lock the row: concurrent requests can't double-spend

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vendor profile not found';
    END IF;
    IF NEW.amount > current_balance THEN
        RAISE EXCEPTION 'Insufficient balance: requested %, available %', NEW.amount, current_balance;
    END IF;

    UPDATE public.vendor_profiles
    SET wallet_balance = wallet_balance - NEW.amount, updated_at = NOW()
    WHERE user_id = NEW.vendor_id
    RETURNING wallet_balance INTO current_balance;

    INSERT INTO public.vendor_ledger (vendor_id, entry_type, amount, balance_after, description)
    VALUES (NEW.vendor_id, 'PAYOUT_WITHDRAWAL', -NEW.amount, current_balance,
            'Payout requested, funds held');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_hold_payout_funds
    BEFORE INSERT ON public.vendor_payouts
    FOR EACH ROW EXECUTE FUNCTION public.hold_payout_funds();

CREATE OR REPLACE FUNCTION public.process_payout_decision()
RETURNS TRIGGER AS $$
DECLARE
    new_balance NUMERIC(12, 2);
BEGIN
    -- Refund held funds if the admin rejects the request
    IF OLD.status = 'REQUESTED' AND NEW.status = 'REJECTED' THEN
        UPDATE public.vendor_profiles
        SET wallet_balance = wallet_balance + OLD.amount, updated_at = NOW()
        WHERE user_id = OLD.vendor_id
        RETURNING wallet_balance INTO new_balance;

        INSERT INTO public.vendor_ledger (vendor_id, entry_type, amount, balance_after, description)
        VALUES (OLD.vendor_id, 'PAYOUT_REFUNDED', OLD.amount, new_balance,
                'Payout rejected, funds released');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_process_payout_decision
    BEFORE UPDATE ON public.vendor_payouts
    FOR EACH ROW EXECUTE FUNCTION public.process_payout_decision();

-- ============================================================================
-- 6. updated_at maintenance
-- ============================================================================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_touch BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_vendor_profiles_touch BEFORE UPDATE ON public.vendor_profiles
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================================
-- 7. FRONTEND WRITE POLICIES
-- ============================================================================

-- Jobs: a customer creates for themselves; a vendor creates on behalf of any
-- customer but can only attach THEMSELVES as vendor_id. The pricing trigger
-- (3) computes total_charged/vendor_cut, so clients can't set their own price.
CREATE POLICY "Create document jobs" ON public.document_jobs
    FOR INSERT TO authenticated
    WITH CHECK (
        (customer_id = auth.uid() OR public.jwt_role() IN ('VENDOR', 'ADMIN'))
        AND (vendor_id IS NULL OR vendor_id = auth.uid() OR public.jwt_role() = 'ADMIN')
    );

-- Payouts: a vendor may only request (status forced to REQUESTED)...
CREATE POLICY "Vendors create payout requests" ON public.vendor_payouts
    FOR INSERT TO authenticated
    WITH CHECK (vendor_id = auth.uid() AND status = 'REQUESTED' AND processed_by IS NULL);

-- Admin policies
CREATE POLICY "Admin manage profiles" ON public.profiles
    FOR ALL TO authenticated
    USING (public.jwt_role() = 'ADMIN') WITH CHECK (public.jwt_role() = 'ADMIN');

CREATE POLICY "Admin manage pricing" ON public.pricing_rules
    FOR ALL TO authenticated
    USING (public.jwt_role() = 'ADMIN') WITH CHECK (public.jwt_role() = 'ADMIN');

CREATE POLICY "Admin manage templates" ON public.templates
    FOR ALL TO authenticated
    USING (public.jwt_role() = 'ADMIN') WITH CHECK (public.jwt_role() = 'ADMIN');

CREATE POLICY "Admin manage vendor profiles" ON public.vendor_profiles
    FOR ALL TO authenticated
    USING (public.jwt_role() = 'ADMIN') WITH CHECK (public.jwt_role() = 'ADMIN');

CREATE POLICY "Admin manage payouts" ON public.vendor_payouts
    FOR ALL TO authenticated
    USING (public.jwt_role() = 'ADMIN') WITH CHECK (public.jwt_role() = 'ADMIN');

-- Vendor profiles: vendors may update ONLY their payout_info column.
-- Implemented with column privileges (RLS alone can't restrict columns).
REVOKE UPDATE ON public.vendor_profiles FROM authenticated;
GRANT UPDATE (payout_info) ON public.vendor_profiles TO authenticated;

CREATE POLICY "Vendors update own payout info" ON public.vendor_profiles
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- 8. Missing indexes
-- ============================================================================
CREATE INDEX idx_vendor_ledger_vendor ON public.vendor_ledger(vendor_id, created_at DESC);
CREATE INDEX idx_vendor_payouts_vendor ON public.vendor_payouts(vendor_id, created_at DESC);
CREATE INDEX idx_document_jobs_created ON public.document_jobs(created_at DESC);

-- ============================================================================
-- REMAINS BACKEND-ONLY (service key, not exposed to the frontend):
--   - document_jobs UPDATE (status flips after Rust generation)
--   - vendor_ledger (written only by triggers + backend)
--   - payments/verification when the gateway lands
-- ============================================================================
