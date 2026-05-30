-- Fix: mark all existing hotels as onboarding_complete.
-- Any hotel already registered has done enough setup to use the dashboard.
-- The onboarding wizard is still shown to brand-new hotels (onboarding_complete = false)
-- but existing hotels that already have rooms/bookings/etc should land on the dashboard.
UPDATE hotels SET onboarding_complete = true WHERE onboarding_complete = false;
